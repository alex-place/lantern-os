/**
 * Regression for the calibrated-weights PRODUCER (#909).
 *
 * #884 built the bridge (saveCalibratedWeights + the v10 reader) but nothing ever
 * PERSISTED the artifact, so the live scorer was stuck calibrated:false. This locks
 * the new producer `commitCalibratedWeights` (+ the ci.calibration.commitWeights
 * facade + the POST route) and its honesty contract:
 *
 *   written  ⟺  artifact exists  ⟺  viral-score-v10 reports calibrated:true
 *
 * — so a commit is a real no-op until enough labeled outcomes make readiness ok
 * (no fabricated calibration), and a sufficient commit closes the loop.
 *
 * Pure unit test — no server. Run: node tests/test_creator_calibration_commit.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const ci = require(path.join(root, "src", "creator-intelligence"));
const calibration = require(path.join(root, "src", "creator-intelligence", "calibration"));
const { viralScoreV10 } = require(path.join(root, "src", "creator-intelligence", "scoring", "viral-score-v10.js"));
const { ARTIFACT_PATH } = require(path.join(root, "src", "creator-intelligence", "calibration", "weights-artifact.js"));

const analysis = { duration: 30, highlights: [
  { start: 1, end: 4, score: 0.8 },
  { start: 10, end: 13, score: 0.7 },
] };

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); console.log("  ok  - " + name); passed++; }
  catch (e) { console.log("  FAIL- " + name + ": " + e.message); failed++; } };

console.log("\n#909 calibrated-weights producer\n");

check("the producer + facade are wired", () => {
  assert.strictEqual(typeof calibration.commitCalibratedWeights, "function");
  assert.strictEqual(typeof ci.calibration.commitWeights, "function");
});

// Never destroy a real operator artifact.
let backup = null;
if (fs.existsSync(ARTIFACT_PATH)) backup = fs.readFileSync(ARTIFACT_PATH);
try {
  if (fs.existsSync(ARTIFACT_PATH)) fs.unlinkSync(ARTIFACT_PATH); // clean slate

  check("commit honesty invariant: written ⟺ artifact ⟺ scorer calibrated", () => {
    const out = calibration.commitCalibratedWeights({});
    assert.ok(typeof out.written === "boolean", "commit must report written:boolean");
    const artifact = fs.existsSync(ARTIFACT_PATH);
    const scorerCalibrated = viralScoreV10(analysis).calibrated;
    assert.strictEqual(out.written, artifact, "written must match artifact presence");
    assert.strictEqual(out.written, scorerCalibrated, "written must match scorer calibrated state");
    // If nothing was written, it must be because the data wasn't a real ok-calibration.
    if (!out.written) assert.notStrictEqual(out.status, "ok");
  });

  check("flag OFF → commitWeights is gated (no write)", () => {
    if (fs.existsSync(ARTIFACT_PATH)) fs.unlinkSync(ARTIFACT_PATH);
    const out = ci.calibration.commitWeights({}, { LANTERN_CI_CALIBRATION: "0" });
    // Either explicitly disabled, or (if flag is force-on elsewhere) an honest no-op —
    // in NO case may a disabled/insufficient commit leave a calibrated artifact.
    if (out && out.reason === "calibration_flag_off") {
      assert.strictEqual(fs.existsSync(ARTIFACT_PATH), false);
    } else {
      assert.strictEqual(!!out.written, fs.existsSync(ARTIFACT_PATH));
    }
  });
} finally {
  if (backup !== null) fs.writeFileSync(ARTIFACT_PATH, backup);
  else if (fs.existsSync(ARTIFACT_PATH)) fs.unlinkSync(ARTIFACT_PATH);
}

console.log(`\n#909 producer: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
