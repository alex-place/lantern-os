// Unit tests for B4 — calibrated re-weighting of the scoring priors.
// Standalone: `node tests/test_weight_calibration.js`.

"use strict";

const assert = require("assert");
const {
  calibrateWeights, COMPONENT_FEATURES, DEFAULT_TARGET,
} = require("../src/creator-intelligence/calibration/weight-calibration");
const PRIORS = require("../src/creator-intelligence/research/viral_patterns.json").weights;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

test("uncalibrated correlations → priors returned UNCHANGED, insufficient_data", () => {
  const r1 = calibrateWeights(PRIORS, { status: "insufficient_data" });
  assert.strictEqual(r1.status, "insufficient_data");
  assert.deepStrictEqual(r1.weights, PRIORS);
  const r2 = calibrateWeights(PRIORS, { status: "ok", calibrated: false, sampleSize: 40, correlations: [] });
  assert.strictEqual(r2.status, "insufficient_data");
  assert.deepStrictEqual(r2.weights, PRIORS);
});

test("calibrated but no mapped-feature correlations → unchanged", () => {
  const corr = { status: "ok", calibrated: true, sampleSize: 150,
    correlations: [{ feature: "somethingUnmapped", metric: DEFAULT_TARGET, r: 0.9, n: 150 }] };
  const res = calibrateWeights(PRIORS, corr);
  assert.strictEqual(res.status, "insufficient_data");
  assert.deepStrictEqual(res.weights, PRIORS);
});

test("strong correlation lifts the mapped component's weight; weights sum to 1", () => {
  // 'hook' maps to timeToFirstEventSec; give it a dominant correlation, others weak.
  const corr = {
    status: "ok", calibrated: true, sampleSize: 300,
    correlations: [
      { feature: "timeToFirstEventSec", metric: DEFAULT_TARGET, r: -0.85, n: 300 }, // |r| 0.85 (hook)
      { feature: "cutsPerMin", metric: DEFAULT_TARGET, r: 0.10, n: 300 },             // retention/pacing
      { feature: "coverage", metric: DEFAULT_TARGET, r: 0.05, n: 300 },
      { feature: "multiSignalSpikesPerMin", metric: DEFAULT_TARGET, r: 0.10, n: 300 }, // surprise
    ],
  };
  const res = calibrateWeights(PRIORS, corr);
  assert.strictEqual(res.status, "ok");
  assert.strictEqual(res.calibrated, true);
  assert.ok(Math.abs(sum(res.weights) - 1) < 1e-3, "weights normalize to ~1 (4-dp rounding)");
  assert.ok(res.weights.hook > PRIORS.hook, "strongly-correlated hook gains weight");
  assert.ok(res.lambda > 0 && res.lambda <= 0.5, "shrinkage in (0, 0.5]");
  // A component with NO mapped correlation (e.g. emotion) keeps ~its prior share.
  assert.ok(Math.abs(res.weights.emotion - PRIORS.emotion) < 0.02);
});

test("shrinkage grows with sample size (more data → more movement)", () => {
  const mk = (n) => ({ status: "ok", calibrated: true, sampleSize: n,
    correlations: [{ feature: "timeToFirstEventSec", metric: DEFAULT_TARGET, r: -0.9, n }] });
  const small = calibrateWeights(PRIORS, mk(120));
  const big = calibrateWeights(PRIORS, mk(2000));
  assert.ok(big.lambda > small.lambda, "larger n => larger λ");
  assert.ok(big.weights.hook >= small.weights.hook, "more data moves hook further");
});

test("COMPONENT_FEATURES covers exactly the prior weight components", () => {
  assert.deepStrictEqual(
    Object.keys(COMPONENT_FEATURES).sort(),
    Object.keys(PRIORS).sort(),
    "every scored component has a feature mapping"
  );
});

console.log(`\n${passed} checks passed.`);
