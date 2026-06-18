// Safe Zone V2.5 — adaptive, confidence-measured caption/overlay placement.
//
// Builds on SafeZoneDetectorV2 (facecam + HUD detection) and adds:
//   • multi-region awareness — fixed YouTube Shorts UI zones (title / action rail
//     / bottom metadata) from safezone-priors.json, plus the detected facecam/HUD
//   • a measured confidence score (safezone-confidence.js) and a retry loop that
//     tries diverse candidate caption zones until one scores >= threshold
//     (the anti-collapse mechanism: captions can't all converge on one bad spot)
//   • EMA temporal smoothing so the chosen zone doesn't jitter between frames,
//     with re-seeding on scene cuts / facecam moves.
//
// Honesty boundary: OCR collision and saliency are PLUGGABLE INPUTS (pass
// `ocrBoxes` / `salience`); they are not bundled here. When omitted, the
// confidence breakdown flags them unmeasured rather than faking a perfect score.

"use strict";

const fs = require("fs");
const path = require("path");
const { scorePlacement } = require("./safezone-confidence");
const v2 = require("./safe-zone-v2");

const PRIORS = JSON.parse(fs.readFileSync(path.join(__dirname, "safezone-priors.json"), "utf-8"));

// A soft "gameplay action" zone (frame centre) — captions parked dead-centre
// obstruct the play even when no HUD is there.
const CENTER_ACTION = { x: 0.30, y: 0.34, width: 0.40, height: 0.32, label: "action-center" };

function uiZones() { return Object.values(PRIORS.shortsUI).filter((z) => z && z.width); }

// Detected regions (from SafeZoneDetectorV2) → the sets the scorer needs, all in
// OUTPUT (9:16) space. Key detail: caption placement is in the final frame, and
// in the facecam-top layout the cam occupies the TOP BAND of that frame — so the
// region captions must avoid is the band, not the source-space facecam rect.
function regionSets(regions, opts = {}) {
  const facecam = (regions || []).find((r) => r.type === "facecam" && !r.needsDeclaration) || null;
  const hasFacecam = !!(facecam || opts.facecam);
  return {
    facecam: hasFacecam ? (opts.facecamRectOutput || PRIORS.facecamBand) : null,
    gameplay: [CENTER_ACTION, ...(opts.gameplayRegions || [])],
    ui: uiZones(),
    hasFacecam,
  };
}

/**
 * Choose the best caption safe zone for ONE scene/frame.
 * Tries each candidate zone, scores it, returns the highest-confidence placement
 * that clears the threshold — or, if none do, the best available (flagged).
 * @param {Array} regions  SafeZoneDetectorV2 regions
 * @param {Object} opts  { prevPlacement, ocrBoxes, facecam, weights, threshold }
 */
function planCaptionSafeZone(regions, opts = {}) {
  const threshold = opts.threshold ?? PRIORS.confidence.threshold;
  const sets = regionSets(regions, opts);
  const ctx = {
    ...sets,
    prevPlacement: opts.prevPlacement || null,
    maxMovement: PRIORS.temporal.maxMovementPerSecond,
    ocrBoxes: opts.ocrBoxes || null, // null => OCR not run (flagged unmeasured)
    weights: opts.weights || PRIORS.confidence.weights,
  };

  // Retry loop: evaluate every candidate zone (diverse placements = anti-collapse).
  const scored = PRIORS.captionCandidateZones.map((zone) => {
    const placement = { x: zone.x, y: zone.y, width: zone.width, height: zone.height };
    return { id: zone.id, placement, ...scorePlacement(placement, ctx) };
  }).sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  const pass = best.confidence >= threshold;
  return {
    zone: best.placement,
    zoneId: best.id,
    confidence: best.confidence,
    components: best.components,
    measured: best.measured,
    overlapPct: best.overlapPct,
    pass,
    belowThreshold: !pass,
    candidates: scored.map((s) => ({ id: s.id, confidence: s.confidence })),
  };
}

// EMA smoothing of a chosen zone toward the previous one (temporal consistency).
// Re-seed (return `next` unchanged) on a scene cut / facecam move / crop change.
function smoothZone(prev, next, opts = {}) {
  if (!prev || opts.reseed) return next;
  const a = opts.alpha ?? PRIORS.temporal.emaAlpha;
  const lerp = (p, n) => p + a * (n - p);
  return {
    x: Number(lerp(prev.x, next.x).toFixed(4)),
    y: Number(lerp(prev.y, next.y).toFixed(4)),
    width: Number(lerp(prev.width, next.width).toFixed(4)),
    height: Number(lerp(prev.height, next.height).toFixed(4)),
  };
}

/**
 * End-to-end: detect a video's regions (SafeZoneDetectorV2) and plan its caption
 * safe zone + confidence. Returns { status:"unavailable" } if ffmpeg can't read it
 * (never fabricates). Per-scene segmentation is a documented extension — this
 * single pass uses the clip's aggregate regions.
 */
async function analyzeVideoSafeZones(videoPath, opts = {}) {
  const res = await v2.analyzeForCrop(videoPath, { fps: opts.fps || 1, ...opts });
  if (res.status !== "ok") return { status: res.status, reason: res.reason };
  const plan = planCaptionSafeZone(res.regions, opts);
  return { status: "ok", regions: res.regions, ...plan };
}

module.exports = {
  planCaptionSafeZone,
  analyzeVideoSafeZones,
  smoothZone,
  regionSets,
  PRIORS,
  CENTER_ACTION,
};
