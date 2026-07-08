// Econ-nowcast MEASUREMENT harness (#2222). Default posture is NO edge; the nowcast must
// demonstrably beat the market (better Brier AND net-positive after fees) over n>=20.
// Run: node apps/lantern-garage/test/econ-nowcast-edge.test.js
const assert = require("assert");
const { brier, netEvCents, measureEdge, buildNowcast, MIN_SAMPLES } = require("../lib/econ-nowcast-edge");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Build n events. mkNowcast(i)->p, mkMarket(i)->p, outcome via a deterministic rule.
function make(n, nowcastFn, marketFn, outcomeFn) {
  return Array.from({ length: n }, (_, i) => ({ nowcastP: nowcastFn(i), marketP: marketFn(i), outcome: outcomeFn(i) }));
}

check("brier scores calibration; perfect prediction → 0", () => {
  const rs = make(4, () => 1, () => 0.5, (i) => (i % 2 ? 1 : 1));
  assert.strictEqual(brier(rs.map((r) => ({ ...r, outcome: 1 })), "nowcastP"), 0);
});

check("below MIN_SAMPLES → no verdict, stand down", () => {
  const rs = make(10, () => 0.7, () => 0.5, () => 1);
  const m = measureEdge(rs);
  assert.strictEqual(m.active, false);
  assert.strictEqual(m.verdict, "insufficient-data");
  assert.strictEqual(MIN_SAMPLES, 20);
});

check("nowcast == market → no demonstrated edge even at n>=20", () => {
  // identical probs → no disagreements, equal Brier
  const rs = make(24, () => 0.5, () => 0.5, (i) => (i % 2));
  const m = measureEdge(rs);
  assert.strictEqual(m.active, true);
  assert.strictEqual(m.verdict, "no-demonstrated-edge");
  assert.strictEqual(m.tradeable, false);
});

check("a market that is BETTER calibrated than the nowcast → stand down", () => {
  // outcome tracks marketP (market is right); nowcast is noisy/overconfident the wrong way
  const rs = make(30, (i) => (i % 2 ? 0.9 : 0.1), () => 0.5, (i) => (i % 3 === 0 ? 1 : 0));
  const m = measureEdge(rs);
  assert.strictEqual(m.verdict, "no-demonstrated-edge");
});

check("only a genuinely superior nowcast is called tradeable", () => {
  // nowcast is right (outcome follows nowcast), market is a coin flip, gaps are large
  const rs = make(30, (i) => (i % 2 ? 0.85 : 0.15), () => 0.5, (i) => (i % 2 ? 1 : 0));
  const m = measureEdge(rs);
  assert.ok(m.brierNowcast < m.brierMarket, "nowcast better calibrated");
  assert.strictEqual(m.verdict, "demonstrated-edge");
  assert.ok(m.evCentsPerContract > 0, "net positive after fees");
});

check("netEvCents ignores events where nowcast agrees with market", () => {
  const rs = make(10, () => 0.5, () => 0.5, () => 1);
  assert.strictEqual(netEvCents(rs).n, 0);
});

check("buildNowcast is an unwired stub (never a silent placeholder)", () => {
  assert.throws(() => buildNowcast("CPI"), /not wired/);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll econ-nowcast-edge tests passed.");
