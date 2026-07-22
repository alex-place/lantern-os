// #2790 (M5): groundingPolicy breadth ramp — linear default unchanged; log ramp
// (KKT water-filling shape) opt-in via { ramp: "log" } or GROUNDING_RAMP=log.
//
// Run: node apps/lantern-garage/test/grounding-policy-ramp.test.js
const assert = require("assert");
const { groundingPolicy, dilation } = require("../lib/grounding-policy");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("default ramp is linear and unchanged (D=5 -> 25 results)", () => {
  const p = groundingPolicy(5.0);
  assert.strictEqual(p.maxResults, 25);
  assert.strictEqual(p.deepMode, true);
  assert.strictEqual(p.minSources, 3);
});

check("log ramp compresses breadth at high D (D=5 -> 13 results)", () => {
  const p = groundingPolicy(5.0, { ramp: "log" });
  // 5 * (1 + ln 5) = 5 * 2.609... -> 13
  assert.strictEqual(p.maxResults, 13);
  // everything except breadth is ramp-invariant
  assert.strictEqual(p.deepMode, true);
  assert.strictEqual(p.minSources, 3);
  assert.strictEqual(p.fetchExternal, true);
});

check("log ramp equals linear at D=1 boundary region (D<=1 untouched)", () => {
  const lin = groundingPolicy(0.9);
  const log = groundingPolicy(0.9, { ramp: "log" });
  assert.deepStrictEqual(lin, log);
  assert.strictEqual(lin.maxResults, 5);
});

check("fetch cutoff (the water level) is ramp-invariant", () => {
  assert.strictEqual(groundingPolicy(0.4, { ramp: "log" }).fetchExternal, false);
  assert.strictEqual(groundingPolicy(0.4).fetchExternal, false);
});

check("log ramp is monotone in D (more uncertainty never means less breadth)", () => {
  let prev = 0;
  for (const D of [1.1, 1.5, 2, 3, 4, 5]) {
    const r = groundingPolicy(D, { ramp: "log" }).maxResults;
    assert.ok(r >= prev, `non-monotone at D=${D}`);
    prev = r;
  }
});

check("env flag GROUNDING_RAMP=log is honored when no explicit ramp", () => {
  const old = process.env.GROUNDING_RAMP;
  process.env.GROUNDING_RAMP = "log";
  try {
    assert.strictEqual(groundingPolicy(5.0).maxResults, 13);
  } finally {
    if (old === undefined) delete process.env.GROUNDING_RAMP;
    else process.env.GROUNDING_RAMP = old;
  }
  assert.strictEqual(groundingPolicy(5.0).maxResults, 25); // back to linear
});

check("dilation() itself is untouched by the ramp option", () => {
  assert.ok(Math.abs(dilation(0.8, 0, 0.5) - (1.8 / 1.5)) < 1e-12);
});

process.exit(failures ? 1 : 0);
