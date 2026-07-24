// #2791 (M6): per-generation canary signal trajectories — flag-gated no-op by
// default; bounded points; healthy-reply events only when CANARY_TRACE=1.
//
// Run: node test/canary-trace.test.js
const assert = require("assert");
const { createCanaryTrace, runCanaries } = require("../lib/canary");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const HEALTHY =
  "The convergence loop observes the world, then reasons about what to do next and acts. " +
  "Each stage strengthens the one before it, and nothing is accepted without checking it " +
  "against something real first.";

const SC = { proximity: 0.4, collapsed: false, signals: { selfRepeatRatio: 0.1, ngramEchoRatio: 0.05, typeTokenRatio: 0.8 } };

check("flag OFF (default): trace is an exact no-op", () => {
  delete process.env.CANARY_TRACE;
  const t = createCanaryTrace();
  assert.strictEqual(t.enabled, false);
  t.push(500, SC);          // must not throw, must not record
  t.reset();
  assert.strictEqual(t.points, null);
});

check("flag ON: points recorded, shaped, and bounded", () => {
  process.env.CANARY_TRACE = "1";
  try {
    const t = createCanaryTrace();
    assert.strictEqual(t.enabled, true);
    for (let i = 0; i < 100; i++) t.push(400 + i * 240, SC);
    assert.ok(t.points.length <= 48, "points must be capped");
    const p = t.points[0];
    assert.deepStrictEqual(Object.keys(p).sort(), ["echo", "len", "prox", "rep", "ttr"].sort());
    t.reset();
    assert.strictEqual(t.points.length, 0);
  } finally {
    delete process.env.CANARY_TRACE;
  }
});

check("runCanaries accepts a trace without behavior change (emit off)", () => {
  process.env.CANARY_TRACE = "1";
  try {
    const t = createCanaryTrace();
    t.push(400, SC);
    const r = runCanaries(HEALTHY, { emit: false, trace: t });
    assert.deepStrictEqual(r.tripped, []);           // healthy stays healthy
    assert.ok(typeof r.signaturePatch.sigma0_proximity === "number");
  } finally {
    delete process.env.CANARY_TRACE;
  }
});

check("flag OFF: runCanaries with a disabled trace emits nothing new (healthy path)", () => {
  delete process.env.CANARY_TRACE;
  const t = createCanaryTrace();
  const r = runCanaries(HEALTHY, { emit: false, trace: t });
  assert.deepStrictEqual(r.tripped, []);
});

process.exit(failures ? 1 : 0);
