// Tests for the B4 callable helper proposeCalibratedWeights — gated against the
// LIVE outcome set: insufficient_data (priors unchanged) until calibration is
// ready. Standalone: `node tests/test_propose_weights.js` (isolated empty store).

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.LANTERN_CI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pw-"));

const calib = require("../src/creator-intelligence/calibration");
const PRIORS = require("../src/creator-intelligence/research/viral_patterns.json").weights;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

test("empty outcome store → insufficient_data with priors returned UNCHANGED", () => {
  const res = calib.proposeCalibratedWeights();
  assert.strictEqual(res.status, "insufficient_data");
  assert.strictEqual(res.calibrated, false);
  assert.deepStrictEqual(res.weights, PRIORS, "weights are the untouched priors");
});

test("priorWeights() exposes the shipped priors (a fresh copy)", () => {
  const w = calib.priorWeights();
  assert.deepStrictEqual(w, PRIORS);
  w.hook = 999; // mutating the copy must not affect the source
  assert.notStrictEqual(calib.priorWeights().hook, 999);
});

test("the proposal carries the prior-weight component set", () => {
  const res = calib.proposeCalibratedWeights();
  assert.deepStrictEqual(Object.keys(res.weights).sort(), Object.keys(PRIORS).sort());
});

console.log(`\n${passed} checks passed.`);
