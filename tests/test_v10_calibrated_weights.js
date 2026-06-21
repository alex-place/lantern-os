/**
 * Calibration -> live-scorer bridge test (B4).
 *
 * Proves the loop closure: a weight-calibration result, persisted via
 * saveCalibratedWeights(), is picked up by the LIVE viral-score-v10 scorer
 * (calibrated:true) and actually drives the weighting — while the honesty contract
 * holds: insufficient_data is never persisted, and an absent artifact leaves the
 * scorer on its priors (calibrated:false).
 *
 * Pure unit test — no server, no network, no model. Run: node tests/test_v10_calibrated_weights.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const { viralScoreV10 } = require(path.join(root, "src", "creator-intelligence", "scoring", "viral-score-v10.js"));
const { loadCalibratedWeights, saveCalibratedWeights, ARTIFACT_PATH } =
  require(path.join(root, "src", "creator-intelligence", "calibration", "weights-artifact.js"));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  - " + name); passed++; }
  catch (e) { console.log("  FAIL- " + name + ": " + e.message); failed++; }
}

// Minimal HighlightTimeline.toJSON()-shaped clip.
const analysis = { duration: 30, highlights: [
  { start: 1, end: 4, score: 0.8 },
  { start: 10, end: 13, score: 0.7 },
] };

// Never destroy a real operator artifact: back it up and restore in finally.
let backup = null;
if (fs.existsSync(ARTIFACT_PATH)) backup = fs.readFileSync(ARTIFACT_PATH);

console.log("\nv10 calibration -> scorer bridge (B4)\n");
try {
  if (fs.existsSync(ARTIFACT_PATH)) fs.unlinkSync(ARTIFACT_PATH); // clean slate

  check("no artifact => scorer stays on priors (calibrated:false)", () => {
    assert.strictEqual(loadCalibratedWeights(), null);
    const r = viralScoreV10(analysis);
    assert.strictEqual(r.calibrated, false, "should be uncalibrated with no artifact");
    assert.ok(/viral_patterns\.json/.test(r.weightsSource), "weightsSource should cite priors, got: " + r.weightsSource);
  });

  check("insufficient_data is NOT persisted (honesty contract)", () => {
    const wrote = saveCalibratedWeights({ status: "insufficient_data", calibrated: false, weights: { hook: 1 } });
    assert.strictEqual(wrote, false, "insufficient_data must not be saved");
    assert.strictEqual(fs.existsSync(ARTIFACT_PATH), false, "no artifact should exist");
    assert.strictEqual(viralScoreV10(analysis).calibrated, false);
  });

  check("a real (status:ok) calibration is persisted + drives the live scorer", () => {
    // Put ALL weight on `hook` so the overall score must equal the hook component score.
    const calWeights = { hook: 1, retention: 0, emotion: 0, surprise: 0, pacing: 0, rewatch: 0, visualClarity: 0, captionPotential: 0 };
    const wrote = saveCalibratedWeights({ status: "ok", calibrated: true, weights: calWeights, sampleSize: 42, targetMetric: "retention", lambda: 0.6 });
    assert.strictEqual(wrote, true, "status:ok must be saved");

    const r = viralScoreV10(analysis);
    assert.strictEqual(r.calibrated, true, "scorer should report calibrated:true");
    assert.ok(/calibrated: operator outcomes \(n=42/.test(r.weightsSource), "weightsSource should cite the calibration, got: " + r.weightsSource);
    const hook = r.componentScores.hook;
    assert.ok(Math.abs(r.viralScore - hook.score) < 0.01,
      `viralScore (${r.viralScore}) should equal hook score (${hook.score}) when hook weight=1`);
  });
} finally {
  if (backup !== null) fs.writeFileSync(ARTIFACT_PATH, backup);
  else if (fs.existsSync(ARTIFACT_PATH)) fs.unlinkSync(ARTIFACT_PATH);
}

console.log(`\nv10 calibration bridge: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
