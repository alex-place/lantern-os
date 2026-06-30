// #1436 — decision journal core logic: validation, grading, and calibration (Brier +
// over/under-confidence). The JSONL persistence is thin I/O; the math is locked here.
//
// Run: node apps/lantern-garage/test/decision-journal.test.js
const assert = require("assert");
const dj = require("../lib/decision-journal");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// normalizeDecision
check("normalizes + clamps + defaults", () => {
  const d = dj.normalizeDecision({ title: "Move cities", confidence: 1.4, category: "bogus" });
  assert.strictEqual(d.confidence, 1);          // clamped
  assert.strictEqual(d.category, "other");      // unknown → other
  assert.strictEqual(d.status, "open");
});
check("requires a title", () => assert.throws(() => dj.normalizeDecision({ confidence: 0.5 }), /title/));
check("requires confidence", () => assert.throws(() => dj.normalizeDecision({ title: "x" }), /confidence/));

// outcomeScore
check("outcome → score mapping", () => {
  assert.strictEqual(dj.outcomeScore("good"), 1);
  assert.strictEqual(dj.outcomeScore("mixed"), 0.5);
  assert.strictEqual(dj.outcomeScore("bad"), 0);
  assert.strictEqual(dj.outcomeScore("???"), null);
});

// gradeDecision
check("confident + good → well-calibrated", () => {
  const g = dj.gradeDecision({ confidence: 0.8, outcome: "good" });
  assert.strictEqual(g.verdict, "well-calibrated");
});
check("very confident + bad → overconfident", () => {
  const g = dj.gradeDecision({ confidence: 0.9, outcome: "bad" });
  assert.strictEqual(g.verdict, "overconfident");
  assert.ok(g.error > 0);
});
check("unsure + good → underconfident", () => {
  const g = dj.gradeDecision({ confidence: 0.2, outcome: "good" });
  assert.strictEqual(g.verdict, "underconfident");
  assert.ok(g.error < 0);
});
check("grade null when unresolved", () =>
  assert.strictEqual(dj.gradeDecision({ confidence: 0.5, outcome: undefined }), null));

// calibration
check("no resolved decisions → insufficient_data", () => {
  const c = dj.calibration([{ status: "open", confidence: 0.7 }]);
  assert.strictEqual(c.status, "insufficient_data");
  assert.strictEqual(c.brier, null);
});

check("perfect calibration → Brier 0, well-calibrated", () => {
  const decisions = [
    { status: "resolved", confidence: 1, outcome: "good" },
    { status: "resolved", confidence: 0, outcome: "bad" },
    { status: "resolved", confidence: 0.5, outcome: "mixed" },
  ];
  const c = dj.calibration(decisions);
  assert.strictEqual(c.n, 3);
  assert.strictEqual(c.brier, 0);
  assert.strictEqual(c.tendency, "well-calibrated");
});

check("systematic overconfidence is detected", () => {
  const decisions = [
    { status: "resolved", confidence: 0.9, outcome: "bad" },
    { status: "resolved", confidence: 0.85, outcome: "bad" },
    { status: "resolved", confidence: 0.95, outcome: "mixed" },
  ];
  const c = dj.calibration(decisions);
  assert.strictEqual(c.tendency, "overconfident");
  assert.ok(c.signedError > 0.1);
  assert.ok(c.goodCallRate < 0.5);
});

check("good-call rate + buckets computed", () => {
  const decisions = [
    { status: "resolved", confidence: 0.7, outcome: "good" },
    { status: "resolved", confidence: 0.75, outcome: "good" },
    { status: "resolved", confidence: 0.3, outcome: "bad" },
  ];
  const c = dj.calibration(decisions);
  assert.ok(Math.abs(c.goodCallRate - (2 / 3)) < 1e-9);
  assert.ok(c.buckets.length >= 1);
  assert.ok(c.buckets.every((b) => b.count >= 1 && b.predicted != null && b.actual != null));
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall decision-journal checks passed\n");
