// #2803 — autowork confidence fields are mostly formula constants; only calibratedTrust
// is outcome-calibrated. The basis helper labels each field so records stop performing
// measurement. Locks the taxonomy + summary.
//
// Run: node test/confidence-basis.test.js
const assert = require("assert");
const { confidenceBasis, basisSummary, basisOf, MEASURED_FIELDS } = require("../lib/confidence-basis");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// The real autowork convergence-record confidence shape.
const CONF = {
  codebaseResearch: 0.85, webGrounded: 0.8, testsPassed: 0.9,
  observable: 1.0, grounded: 0.8, overall: 0.84, calibratedTrust: 0.5,
};

check("calibratedTrust is the ONLY measured field", () => {
  assert.strictEqual(basisOf("calibratedTrust"), "measured");
  assert.deepStrictEqual([...MEASURED_FIELDS], ["calibratedTrust"]);
});
check("every non-calibrated field is a prior", () => {
  for (const f of ["codebaseResearch", "webGrounded", "testsPassed", "observable", "grounded", "overall"]) {
    assert.strictEqual(basisOf(f), "prior", `${f} should be prior`);
  }
});
check("confidenceBasis labels a full confidence object", () => {
  const b = confidenceBasis(CONF);
  assert.strictEqual(b.calibratedTrust, "measured");
  assert.strictEqual(b.overall, "prior");
  assert.strictEqual(b.testsPassed, "prior");
  // one key per confidence field, no extras
  assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(CONF).sort());
});
check("the overall (the '84%') is explicitly a prior, not a measurement", () => {
  assert.strictEqual(confidenceBasis(CONF).overall, "prior");
});
check("basisSummary reports exactly 1 measured, 6 prior", () => {
  const s = basisSummary(CONF);
  assert.deepStrictEqual(s.measured, ["calibratedTrust"]);
  assert.strictEqual(s.prior.length, 6);
  assert.match(s.label, /1 measured \(calibratedTrust\), 6 prior/);
});
check("empty / null confidence → empty basis, no throw", () => {
  assert.deepStrictEqual(confidenceBasis(null), {});
  assert.deepStrictEqual(confidenceBasis({}), {});
  assert.match(basisSummary({}).label, /0 measured \(none\), 0 prior/);
});
check("unknown fields default to prior (never silently 'measured')", () => {
  assert.strictEqual(basisOf("someNewScore"), "prior");
});

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
