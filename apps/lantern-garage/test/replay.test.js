// #1419 — convergence replay timeline + regression detection. Pure builders, no I/O.
//
// Run: node apps/lantern-garage/test/replay.test.js
const assert = require("assert");
const rp = require("../lib/replay");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const recs = [
  { timestamp: "2026-06-30T00:00:03Z", hypothesis: "C is true", confidence: 0.9, verified: true, reasoner: "keystone", result: "passed" },
  { timestamp: "2026-06-30T00:00:01Z", hypothesis: "A is true", confidence: 0.5, reasoner: "lantern", result: "ok" },
  { timestamp: "2026-06-30T00:00:02Z", hypothesis: "B is false", confidence: 0.2, verified: false, reasoner: "keystone", result: "refuted" },
];

check("buildTimeline sorts chronologically", () => {
  const t = rp.buildTimeline(recs);
  assert.deepStrictEqual(t.map((s) => s.hypothesis), ["A is true", "B is false", "C is true"]);
});

check("computes confidence delta vs previous step", () => {
  const t = rp.buildTimeline(recs);
  assert.strictEqual(t[0].delta, null);          // first
  assert.strictEqual(t[1].delta, -0.3);          // 0.2 - 0.5
  assert.ok(Math.abs(t[2].delta - 0.7) < 1e-9);  // 0.9 - 0.2
});

check("normalizeStep pulls hypothesis/result/verified/confidence", () => {
  const s = rp.normalizeStep(recs[0], 0);
  assert.strictEqual(s.hypothesis, "C is true");
  assert.strictEqual(s.verified, true);
  assert.strictEqual(s.confidence, 0.9);
});

check("buildTimeline filters by reasoner", () => {
  const t = rp.buildTimeline(recs, { reasoner: "keystone" });
  assert.strictEqual(t.length, 2);
  assert.ok(t.every((s) => s.reasoner === "keystone"));
});

check("reasoners lists the distinct reasoners", () => {
  assert.deepStrictEqual(rp.reasoners(rp.buildTimeline(recs)), ["keystone", "lantern"]);
});

check("replayState returns the step + trajectory up to the index", () => {
  const t = rp.buildTimeline(recs);
  const st = rp.replayState(t, 1);
  assert.strictEqual(st.index, 1);
  assert.strictEqual(st.total, 3);
  assert.deepStrictEqual(st.trajectory, [0.5, 0.2]);
  assert.ok(Math.abs(st.progress - 0.5) < 1e-9);
});

check("replayState clamps out-of-range index", () => {
  const t = rp.buildTimeline(recs);
  assert.strictEqual(rp.replayState(t, 99).index, 2);
  assert.strictEqual(rp.replayState(t, -5).index, 0);
});

check("replayState handles an empty timeline", () => {
  const st = rp.replayState([], 0);
  assert.strictEqual(st.total, 0);
  assert.strictEqual(st.step, null);
});

check("findRegressions flags sharp confidence drops, flips, and refuted results", () => {
  const t = rp.buildTimeline(recs);
  const regs = rp.findRegressions(t);
  // "B is false": delta -0.3 (sharp drop) + verified false + result 'refuted' → flagged once
  assert.ok(regs.some((g) => g.hypothesis === "B is false"));
  assert.ok(!regs.some((g) => g.hypothesis === "A is true"));   // no drop, no flip
});

check("regression dropThreshold is configurable", () => {
  const t = rp.buildTimeline(recs);
  assert.strictEqual(rp.findRegressions(t, { dropThreshold: 0.99 }).filter((g) => /dropped/.test(g.reason)).length, 0);
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall replay checks passed\n");
