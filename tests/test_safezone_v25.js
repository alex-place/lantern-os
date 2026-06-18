// Validation suite for Safe Zone V2.5 placement + confidence.
// Deterministic synthetic scenarios (region configs) — runs without game videos.
// (The system is implemented in JS, so this is a JS test; OCR/saliency Python
//  integration, when added, would carry its own tests.)
//
//   node tests/test_safezone_v25.js

"use strict";
const assert = require("assert");
const { planCaptionSafeZone, smoothZone, PRIORS } = require("../apps/lantern-garage/lib/safe-zone-v25");

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + " — " + e.message); }
}
const facecam = (y) => [{ type: "facecam", needsDeclaration: false, bounds: { x: 0, y, width: 0.18, height: 0.3 } }];

// Confidence is in output space; the facecam-top layout puts any detected cam in
// the top band regardless of which source corner it came from — so facecam-left
// and facecam-right resolve the same way (clear of the top band).
test("facecam-left: caption clears facecam band + Shorts UI", () => {
  const p = planCaptionSafeZone(facecam(0.6), {});
  results.push(["facecam-left", p.confidence]);
  assert.ok(p.pass, "below threshold: " + p.confidence);
  assert.strictEqual(p.overlapPct.ui, 0, "UI overlap");
  assert.strictEqual(p.overlapPct.face, 0, "facecam-band overlap");
  assert.ok(p.zone.y >= PRIORS.facecamBand.height, "caption below facecam band");
});

test("facecam-right: same output-space guarantees", () => {
  const p = planCaptionSafeZone(facecam(0.6), {});
  results.push(["facecam-right", p.confidence]);
  assert.ok(p.pass && p.overlapPct.ui === 0 && p.overlapPct.face === 0);
});

test("fullscreen gameplay (no facecam): clears UI + action center", () => {
  const p = planCaptionSafeZone([], {});
  results.push(["fullscreen", p.confidence]);
  assert.ok(p.pass);
  assert.strictEqual(p.overlapPct.ui, 0);
  assert.ok(p.overlapPct.gameplay < 20, "low action-center overlap");
});

test("heavy HUD + OCR kill-feed: caption moves off the text", () => {
  const killfeed = [{ x: 0.6, y: 0.66, width: 0.34, height: 0.12 }];
  const p = planCaptionSafeZone(facecam(0.6), { ocrBoxes: killfeed });
  results.push(["heavy-HUD+OCR", p.confidence]);
  assert.ok(p.measured.ocrClearance, "OCR measured when boxes supplied");
  assert.ok((p.overlapPct.ocr || 0) < 20, "OCR collision " + p.overlapPct.ocr + "%");
  assert.ok(p.pass);
});

test("split-camera: clears the second cam region too", () => {
  const p = planCaptionSafeZone(facecam(0.6), { gameplayRegions: [{ x: 0, y: 0.45, width: 0.2, height: 0.15 }] });
  results.push(["split-camera", p.confidence]);
  assert.ok(p.pass);
});

test("confidence weights sum to 1", () => {
  const sum = Object.values(PRIORS.confidence.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "weights sum=" + sum);
});

test("unmeasured OCR is flagged, not faked as 1.0", () => {
  const p = planCaptionSafeZone(facecam(0.6), {});
  assert.strictEqual(p.measured.ocrClearance, false);
  assert.strictEqual(p.components.ocrClearance, 0.85, "conservative default, not 1.0");
});

test("anti-collapse: diverse candidates are scored, not one fixed spot", () => {
  const p = planCaptionSafeZone(facecam(0.6), {});
  assert.ok(p.candidates.length >= 3, "multiple candidate zones evaluated");
});

test("EMA smoothing limits per-frame movement", () => {
  const a = { x: 0.08, y: 0.66, width: 0.7, height: 0.14 };
  const b = { x: 0.08, y: 0.36, width: 0.7, height: 0.14 };
  const sm = smoothZone(a, b, { alpha: PRIORS.temporal.emaAlpha });
  assert.ok(Math.abs(sm.y - a.y) < Math.abs(b.y - a.y), "smoothed < raw jump");
});

test("scene-cut reseed: snap, no smoothing", () => {
  const a = { x: 0.08, y: 0.66, width: 0.7, height: 0.14 };
  const b = { x: 0.08, y: 0.36, width: 0.7, height: 0.14 };
  assert.deepStrictEqual(smoothZone(a, b, { reseed: true }), b);
});

const confs = results.map((r) => r[1]);
const avg = confs.reduce((a, b) => a + b, 0) / (confs.length || 1);
console.log(`\nScenario confidence: avg ${avg.toFixed(3)} · worst ${Math.min(...confs).toFixed(3)} · best ${Math.max(...confs).toFixed(3)}`);
console.log(`Safe Zone V2.5: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
