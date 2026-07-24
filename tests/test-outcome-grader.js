/**
 * Unit tests for the outcome grader (#1011): Brier + ECE calibration math.
 *   - apps/lantern-garage/lib/outcome-grader.js
 *
 * Plain node + assert. Run: node apps/lantern-garage/tests/test-outcome-grader.js
 * (Replaces the truncated, framework-style draft that shipped in PR #1015.)
 */
const assert = require("assert");
const path = require("path");
const { computeBrier, trackECE, computeMultiClassBrier } = require(
  path.resolve(__dirname, "..", "lib", "outcome-grader.js"));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  -", name); passed++; }
  catch (e) { console.log("  FAIL-", name, "::", e.message); failed++; }
}

test("computeBrier: squared error of confidence vs binary outcome", () => {
  assert.ok(Math.abs(computeBrier(0.7, 0).brier - 0.49) < 1e-9);     // (0.7-0)^2 (float-safe)
  assert.ok(Math.abs(computeBrier(0.7, 1).brier - 0.09) < 1e-9);     // (0.7-1)^2
  assert.strictEqual(computeBrier(1, 1).brier, 0);
  assert.strictEqual(computeBrier(0.7, 0).calibrationMetric, 0.7);   // |error|
});

test("computeBrier: rejects out-of-range predictions", () => {
  assert.ok(computeBrier(1.5, 1).error, "1.5 rejected");
  assert.ok(computeBrier(-0.1, 0).error, "-0.1 rejected");
});

test("trackECE: a perfectly-calibrated set has ~0 ECE", () => {
  // ten 0.9-confidence predictions, exactly 9/10 right → avgConf 0.9 == accuracy 0.9
  const { ece } = trackECE(Array(10).fill(0.9), [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  assert.ok(ece < 0.05, `well-calibrated → ece ${ece} < 0.05`);
});

test("trackECE: overconfident predictions have high ECE", () => {
  // ten 0.9-confidence predictions, all wrong → |0.9 - 0| = 0.9
  const { ece } = trackECE(Array(10).fill(0.9), Array(10).fill(0));
  assert.ok(ece > 0.8, `overconfident → ece ${ece} > 0.8`);
});

test("trackECE: empty input → 0; length mismatch → error", () => {
  assert.strictEqual(trackECE([], []).ece, 0);
  assert.ok(trackECE([0.5], [1, 0]).error, "length mismatch rejected");
});

test("computeMultiClassBrier: sum of squared errors across classes", () => {
  // [0.7, 0.2, 0.1], true class 0 → 0.09 + 0.04 + 0.01 = 0.14
  assert.ok(Math.abs(computeMultiClassBrier([0.7, 0.2, 0.1], 0).brier - 0.14) < 1e-9);
  assert.ok(computeMultiClassBrier([0.5, 0.5], 5).error, "out-of-range index rejected");
});

console.log(`\noutcome-grader: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
