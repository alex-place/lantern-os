// #1435 — symptom journal: factor↔severity patterns with cite-or-abstain discipline.
//
// Run: node apps/lantern-garage/test/health-journal.test.js
const assert = require("assert");
const hj = require("../lib/health-journal");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const E = (severity, factors) => ({ symptom: "headache", severity, factors });

check("abstains when either side is under the data floor", () => {
  const r = hj.factorEffect([E(8, ["x"]), E(7, ["x"]), E(2, [])], "x");
  assert.strictEqual(r.status, "insufficient_data");        // only 1 day without
  assert.ok(/not enough/i.test(r.verdict));
});

check("reports a worse-on-factor pattern once both sides clear MIN_N", () => {
  const entries = [
    E(8, ["poor sleep"]), E(7, ["poor sleep"]), E(9, ["poor sleep"]),
    E(3, []), E(2, []), E(4, []),
  ];
  const r = hj.factorEffect(entries, "poor sleep");
  assert.strictEqual(r.status, "ok");
  assert.ok(r.diff > 0);
  assert.ok(/WORSE/.test(r.verdict));
  assert.ok(/not a proven cause/.test(r.verdict));          // never claims causation
});

check("reports a better-on-factor pattern", () => {
  const entries = [
    E(2, ["exercise"]), E(3, ["exercise"]), E(2, ["exercise"]),
    E(7, []), E(8, []), E(6, []),
  ];
  const r = hj.factorEffect(entries, "exercise");
  assert.ok(r.diff < 0);
  assert.ok(/BETTER/.test(r.verdict));
});

check("calls a tiny difference no clear association", () => {
  const entries = [E(5, ["a"]), E(5, ["a"]), E(5, ["a"]), E(5, []), E(5, []), E(5, [])];
  assert.ok(/No clear association/.test(hj.factorEffect(entries, "a").verdict));
});

check("confidence grows with data but is hard-capped (never certain)", () => {
  const many = [];
  for (let i = 0; i < 100; i++) many.push(E(i % 2 ? 8 : 3, i % 2 ? ["f"] : []));
  const r = hj.factorEffect(many, "f");
  assert.ok(r.confidence <= 0.85);
  assert.strictEqual(r.confidence, 0.85);                   // capped despite huge n
});

check("findPatterns sorts by |effect|, separates insufficient, always carries disclaimer", () => {
  const entries = [
    E(9, ["sleep"]), E(8, ["sleep"]), E(9, ["sleep"]), E(2, []), E(3, []), E(2, []),
    E(5, ["rare"]),   // appears once → insufficient
  ];
  const p = hj.findPatterns(entries);
  assert.ok(p.patterns.some((x) => x.factor === "sleep"));
  assert.ok(p.insufficient.some((x) => x.factor === "rare"));
  assert.ok(/clinician/.test(p.disclaimer));
});

check("summary abstains on empty, carries disclaimer", () => {
  const s = hj.summary([]);
  assert.strictEqual(s.status, "insufficient_data");
  assert.ok(/clinician/.test(s.disclaimer));
});

check("summary computes averages + top symptoms when populated", () => {
  const s = hj.summary([E(6, []), { symptom: "nausea", severity: 4, factors: [] }, E(8, [])]);
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.topSymptoms[0].symptom, "headache");
  assert.ok(/clinician/.test(s.disclaimer));
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall health-journal checks passed\n");
