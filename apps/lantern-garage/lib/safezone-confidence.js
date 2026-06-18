// Safe Zone V2.5 — measured placement confidence.
//
//   confidence = 0.25·faceSeparation + 0.25·gameplaySeparation
//              + 0.20·uiSeparation   + 0.15·motionStability + 0.15·ocrClearance
//
// Each component is 0..1 (1 = no conflict). Honesty boundary: every component is
// a real geometric measurement against detected/known regions. OCR clearance and
// motion stability are only "measured" when the caller actually supplies OCR
// boxes / a previous placement — otherwise they're flagged unmeasured so a report
// never presents an unmeasured 1.0 as fact.

"use strict";

const DEFAULT_WEIGHTS = {
  faceSeparation: 0.25,
  gameplaySeparation: 0.25,
  uiSeparation: 0.20,
  motionStability: 0.15,
  ocrClearance: 0.15,
};

function norm(r) {
  return { x: r.x, y: r.y, w: r.width != null ? r.width : r.w, h: r.height != null ? r.height : r.h };
}

// Fraction of rect a's area that rect b covers (0 = clear, 1 = fully covered).
function overlapFraction(a, b) {
  a = norm(a); b = norm(b);
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = Math.max(1e-9, a.w * a.h);
  return Math.min(1, (ix * iy) / area);
}

// 1 - the worst overlap with any region in the set (1 = clear of all).
function separation(placement, regions) {
  let worst = 0;
  for (const r of regions || []) if (r) worst = Math.max(worst, overlapFraction(placement, r));
  return 1 - worst;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const r3 = (n) => Number(n.toFixed(3));

/**
 * Score a caption placement against the detected scene.
 * @param {{x,y,width,height}} placement  normalized rect in the output frame
 * @param {Object} ctx
 *   facecam      : rect|null    face/body region to avoid (never cover)
 *   gameplay     : rect[]        HUD / action regions not to obstruct
 *   ui           : rect[]        Shorts UI exclusion zones (title / rail / metadata)
 *   prevPlacement: rect|null     previous placement (temporal stability)
 *   maxMovement  : number        normalized movement budget per step (default 0.06)
 *   ocrBoxes     : rect[]|null    detected text boxes; null => OCR not run
 *   weights      : Object
 */
function scorePlacement(placement, ctx = {}) {
  const w = ctx.weights || DEFAULT_WEIGHTS;
  const measured = {
    faceSeparation: true, gameplaySeparation: true, uiSeparation: true,
    motionStability: !!ctx.prevPlacement, ocrClearance: Array.isArray(ctx.ocrBoxes),
  };

  const faceSeparation = ctx.facecam ? separation(placement, [ctx.facecam]) : 1;
  const gameplaySeparation = separation(placement, ctx.gameplay || []);
  const uiSeparation = separation(placement, ctx.ui || []);

  let motionStability = 1;
  if (ctx.prevPlacement) {
    const dx = (placement.x + placement.width / 2) - (ctx.prevPlacement.x + ctx.prevPlacement.width / 2);
    const dy = (placement.y + placement.height / 2) - (ctx.prevPlacement.y + ctx.prevPlacement.height / 2);
    motionStability = clamp01(1 - Math.hypot(dx, dy) / Math.max(1e-6, ctx.maxMovement || 0.06));
  }

  // OCR not run → conservative neutral (not 1.0), so we never inflate confidence.
  const ocrClearance = Array.isArray(ctx.ocrBoxes) ? separation(placement, ctx.ocrBoxes) : 0.85;

  const components = { faceSeparation, gameplaySeparation, uiSeparation, motionStability, ocrClearance };
  let confidence = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) confidence += (w[k] ?? DEFAULT_WEIGHTS[k]) * components[k];

  return {
    confidence: r3(clamp01(confidence)),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, r3(v)])),
    measured,
    overlapPct: {
      ui: r3((1 - uiSeparation) * 100),
      face: r3((1 - faceSeparation) * 100),
      gameplay: r3((1 - gameplaySeparation) * 100),
      ocr: measured.ocrClearance ? r3((1 - ocrClearance) * 100) : null,
    },
  };
}

module.exports = { scorePlacement, overlapFraction, separation, DEFAULT_WEIGHTS };
