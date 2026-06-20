// test_grounding_policy.js — the within→without bridge in the chat (#764).
// JS mirror of the Python dilation/grounding_policy tests. Run: node tests/test_grounding_policy.js
const assert = require("node:assert");
const {
  dilation, groundingPolicy, chatDilation, D_MIN,
} = require("../apps/lantern-garage/lib/grounding-policy");

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok -", name); };

console.log("grounding-policy (chat within→without bridge)");

// G12 sign-fix: near collapse, dilation DEFLATES toward D_MIN, not inflates.
ok("collapse proximity deflates dilation", () => {
  const far = dilation(1.0, 0.0, 0.0, 0.0);
  const near = dilation(1.0, 0.0, 0.0, 1.0);
  assert.ok(far > near, "proximity should reduce D");
  assert.ok(Math.abs(near - D_MIN) < 1e-9, "proximity=1 => D_MIN");
});

ok("proximity 0 is backward-compatible", () => {
  assert.ok(Math.abs(dilation(0.7, 0.1, 0.3) - dilation(0.7, 0.1, 0.3, 0.0)) < 1e-12);
});

ok("proximity monotone (down)", () => {
  const vals = [0, 0.25, 0.5, 0.75, 1].map((p) => dilation(0.9, 0, 0.1, p));
  for (let i = 0; i < vals.length - 1; i++) assert.ok(vals[i] >= vals[i + 1]);
});

// grounding_policy: higher dilation buys more external grounding.
ok("low dilation is cheap", () => {
  const pol = groundingPolicy(0.4);
  assert.strictEqual(pol.fetchExternal, false);
  assert.strictEqual(pol.deepMode, false);
  assert.strictEqual(pol.maxResults, 5);
});

ok("high dilation grounds harder + deep", () => {
  const lo = groundingPolicy(1.0);
  const hi = groundingPolicy(4.0);
  assert.ok(hi.maxResults > lo.maxResults);
  assert.ok(hi.minSources >= lo.minSources);
  assert.strictEqual(hi.deepMode, true);
  assert.strictEqual(lo.deepMode, false);
});

ok("grounding maxResults monotone in dilation", () => {
  const mrs = [D_MIN, 0.5, 1.0, 2.0, 3.0, 5.0].map((d) => groundingPolicy(d).maxResults);
  for (let i = 0; i < mrs.length - 1; i++) assert.ok(mrs[i] <= mrs[i + 1]);
});

// chatDilation: an uncertain/fresh/analytical query dilates more than a plain one.
ok("uncertain query dilates more than a plain one", () => {
  const plain = chatDilation("hello there");
  const uncertain = chatDilation("compare the latest 2026 models — why exactly, and is it true??");
  assert.ok(uncertain > plain, `uncertain(${uncertain}) should exceed plain(${plain})`);
  // and that maps to wider grounding
  assert.ok(groundingPolicy(uncertain).maxResults >= groundingPolicy(plain).maxResults);
});

console.log(`\nPASS — ${n} grounding-policy checks`);
