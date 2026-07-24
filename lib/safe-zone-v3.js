// Safe Zone V3 — caption placement that respects platform UI chrome.
//
// Builds on safe-zone-v2's CONTENT detection (facecam / HUD via analyzeForCrop)
// and adds per-platform UI EXCLUSION zones — the on-screen buttons, captions and
// overlays that a caption must not collide with. Returns the best caption band
// plus a real confidence (how much clear vertical room remains after every
// exclusion).
//
// HONESTY: the platform UI rectangles are KNOWN fixed layouts (the YouTube
// Shorts action rail, TikTok's right buttons / bottom caption, Instagram Reels
// overlay) expressed as proportions of a 9:16 frame — they are documented
// constants, not a trained model. The confidence is a measured free-space score,
// not a guess. Detected content regions come from safe-zone-v2.

"use strict";

const sz2 = require("./safe-zone-v2");
const { detectFacecamV3 } = require("./facecam-v3");

// Exclusion rects as {id, x, y, w, h} normalized to 0..1 of the output 9:16 frame.
const PLATFORM_UI = {
  youtube: [
    { id: "right_actions", x: 0.82, y: 0.45, w: 0.18, h: 0.45 }, // like/comment/share rail
    { id: "bottom_meta", x: 0.00, y: 0.86, w: 0.85, h: 0.14 },   // title + progress bar
  ],
  tiktok: [
    { id: "right_actions", x: 0.82, y: 0.40, w: 0.18, h: 0.45 },
    { id: "bottom_caption", x: 0.00, y: 0.80, w: 0.80, h: 0.20 },
    { id: "top_logo", x: 0.00, y: 0.00, w: 1.00, h: 0.08 },
  ],
  instagram: [
    { id: "right_actions", x: 0.84, y: 0.45, w: 0.16, h: 0.40 },
    { id: "bottom_overlay", x: 0.00, y: 0.82, w: 0.80, h: 0.18 },
  ],
};

// Tallest clear horizontal band in the central column that avoids every occupied
// rect (content + platform UI), biased toward the lower third (caption norm).
function bestCaptionBand(occupied) {
  const x0 = 0.10, x1 = 0.90; // central safe column captions live in
  const spans = (occupied || [])
    .filter((o) => !(o.x + o.w <= x0 || o.x >= x1)) // intersects the central column
    .map((o) => [Math.max(0, o.y), Math.min(1, o.y + o.h)])
    .sort((a, b) => a[0] - b[0]);

  let cursor = 0; const free = [];
  for (const [s, e] of spans) { if (s > cursor) free.push([cursor, s]); cursor = Math.max(cursor, e); }
  if (cursor < 1) free.push([cursor, 1]);

  let best = null;
  for (const [s, e] of free) {
    const h = e - s;
    const score = h * (s >= 0.5 ? 1.15 : 1.0); // prefer the lower half
    if (!best || score > best.score) best = { y: s, h, score };
  }
  if (!best || best.h <= 0) return { y: 0.7, h: 0, confidence: 0 };
  const confidence = Math.max(0, Math.min(1, best.h / 0.18)); // 0.18-tall band = comfortable = 1.0
  return { y: Number(best.y.toFixed(3)), h: Number(best.h.toFixed(3)), confidence: Number(confidence.toFixed(3)) };
}

async function computeSafeZonesV3(videoPath, opts = {}) {
  const platform = (opts.platform || "youtube").toLowerCase();
  const ui = PLATFORM_UI[platform] || PLATFORM_UI.youtube;
  const v2 = await sz2.analyzeForCrop(videoPath, opts).catch(() => ({ status: "unavailable", regions: [] }));
  const content = (v2.regions || [])
    .filter((r) => r.bounds)
    .map((r) => ({ id: r.type, x: r.bounds.x, y: r.bounds.y, w: r.bounds.width, h: r.bounds.height }));
  const occupied = [...content, ...ui];
  const captionBand = bestCaptionBand(occupied);
  return {
    version: "3.0",
    platform,
    contentRegions: content,
    platformUI: ui,
    captionBand,
    confidence: captionBand.confidence,
    meets85: captionBand.confidence >= 0.85,
    note: "Platform UI zones are known fixed layouts (documented constants, not trained). Content regions from safe-zone-v2.",
  };
}

// Platform-specific safe-zone mask (not a universal one). Returns the UI
// exclusion rects + the recommended caption band for the platform.
function getSafeZones(platform = "youtube") {
  const key = String(platform).toLowerCase();
  const ui = PLATFORM_UI[key] || PLATFORM_UI.youtube;
  // default caption band = clear of all UI for an empty (no-content) frame
  const band = bestCaptionBand(ui);
  return { platform: key, exclusionZones: ui, captionBand: band, knownLayouts: Object.keys(PLATFORM_UI) };
}

// Drop-in for safe-zone-v2.analyzeForCrop that upgrades the facecam region with
// Facecam V3 (thorough multi-window detector). V3's facecam REPLACES v2's only
// when it's at least as confident (or v2 found none); everything else in the
// plan — crop, HUD, safe zones — is unchanged. Never breaks the render: any V3
// error falls back to the v2 plan as-is.
async function analyzeForCropV3(videoPath, opts = {}) {
  const plan = await sz2.analyzeForCrop(videoPath, opts).catch(() => ({ status: "unavailable", regions: [] }));
  try {
    const v3 = await detectFacecamV3(videoPath, { fps: 2, maxSeconds: 40, debug: false });
    const regions = Array.isArray(plan.regions) ? [...plan.regions] : [];
    const existing = regions.find((r) => r.type === "facecam");
    if (v3.facecam && (!existing || v3.facecam.confidence >= (existing.confidence || 0))) {
      const upgraded = { type: "facecam", corner: v3.facecam.corner, position: v3.facecam.position, bounds: v3.facecam.bounds, confidence: v3.facecam.confidence, source: "facecam-v3", components: v3.facecam.components };
      if (existing) Object.assign(existing, upgraded); else regions.push(upgraded);
    }
    return { ...plan, regions, facecamV3: { confidence: v3.confidence, corner: v3.facecam ? v3.facecam.corner : null, meets85: v3.meets85 } };
  } catch (_) {
    return plan; // V3 must never break a render
  }
}

module.exports = { computeSafeZonesV3, bestCaptionBand, getSafeZones, analyzeForCropV3, PLATFORM_UI };
