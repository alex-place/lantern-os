// Creator Intelligence — calibrated-weights artifact (B4 → live-scorer bridge).
//
// Persists / loads the operator-specific calibrated V10 viral weights produced by
// weight-calibration.calibrateWeights(). This is the bridge from the calibration loop
// to the LIVE scorer (the thing calibration-engine.js calls "the bridge the V10 scorer
// has been waiting on"): when a calibration run yields status:"ok" weights from the
// operator's real labeled outcomes, they are saved here and viral-score-v10 scores with
// them (calibrated:true). Until then the artifact is absent and scoring stays on the
// heuristic / open-video priors (calibrated:false).
//
// HONESTY CONTRACT: saveCalibratedWeights persists ONLY a real, sufficient calibration
// (status:"ok", calibrated:true). insufficient_data is never written, so the live scorer
// can never report a calibration the data doesn't support.
"use strict";

const fs = require("fs");
const path = require("path");

// repo-root/data/creator-intelligence/calibrated-weights.json (runtime artifact, gitignored).
const ARTIFACT_PATH = path.resolve(
  __dirname, "..", "..", "..", "data", "creator-intelligence", "calibrated-weights.json"
);

/**
 * Load the persisted calibrated weights, or null if absent/invalid.
 * @returns {null | { weights:Object, sampleSize:?number, targetMetric:?string, lambda:?number, calibratedAt:?string }}
 */
function loadCalibratedWeights(artifactPath = ARTIFACT_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
    if (raw && raw.status === "ok" && raw.calibrated === true
        && raw.weights && typeof raw.weights === "object") {
      return {
        weights: raw.weights,
        sampleSize: raw.sampleSize ?? null,
        targetMetric: raw.targetMetric ?? null,
        lambda: raw.lambda ?? null,
        calibratedAt: raw.calibratedAt ?? null,
      };
    }
  } catch (_) { /* absent or unreadable => no calibration */ }
  return null;
}

/**
 * Persist a weight-calibration.calibrateWeights() result — ONLY if it is a real,
 * sufficient calibration. Returns true if written, false if rejected.
 */
function saveCalibratedWeights(result, artifactPath = ARTIFACT_PATH) {
  if (!result || result.status !== "ok" || result.calibrated !== true
      || !result.weights || typeof result.weights !== "object") {
    return false;
  }
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const record = { ...result, calibratedAt: result.calibratedAt || new Date().toISOString() };
  fs.writeFileSync(artifactPath, JSON.stringify(record, null, 2));
  return true;
}

module.exports = { loadCalibratedWeights, saveCalibratedWeights, ARTIFACT_PATH };
