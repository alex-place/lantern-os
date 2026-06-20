// Σ₀ caption PLACEMENT — where captions go, not how they look.
//
// Composition priority (handoff): gameplay = immovable centre, facecam =
// secondary (orbits gameplay), captions = tertiary (orbit BOTH). So captions are
// placed in the best open vertical band that avoids:
//   - the facecam band
//   - the gameplay action centre (crosshair / health / killfeed live ~centre)
//   - platform UI (bottom meta/caption bar, top logo) in the central column
// and obey the orbit rule: facecam top ⇒ captions low, facecam bottom ⇒ high,
// facecam side / none ⇒ lower-third (the convention).
//
// HONESTY: the platform UI rectangles and the lower-third convention are
// documented design defaults from PUBLIC short-form layouts — not measurements
// scraped from specific (copyrighted) creators' videos.

"use strict";

// Platform UI exclusion zones, normalized 0..1 of the output 9:16 frame.
const PLATFORM_UI = {
  youtube: [
    { id: "right_actions", x: 0.82, y: 0.45, w: 0.18, h: 0.45 },
    { id: "bottom_meta", x: 0.00, y: 0.86, w: 0.85, h: 0.14 },
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

const SAFE_GAMEPLAY_ZONE = { x: 0.15, y: 0.35, width: 0.70, height: 0.50 };
const ACTION_CENTER = [0.40, 0.60]; // crosshair / HUD action — captions never here
const CENTRAL_COLUMN = [0.10, 0.90]; // captions are centred horizontally in this column

function round3(x) { return Number((x || 0).toFixed(3)); }

// Merge forbidden intervals and return the clear gaps within [lo, hi].
function clearGaps(intervals, lo, hi) {
  const xs = intervals
    .map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const gaps = []; let cur = lo;
  for (const [a, b] of xs) { if (a > cur) gaps.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < hi) gaps.push([cur, hi]);
  return gaps;
}

/**
 * Best caption band for the OUTPUT frame.
 * @param {Object} opts
 *   - facecam : { bounds:{x,y,width,height}, position?, corner? } in OUTPUT coords, or null
 *   - platform: "youtube" | "tiktok" | "instagram"
 *   - frameH  : output height in px (for a pixel Y), default 1920
 * @returns { ok, captionY, captionHeight, captionYpx, anchor, orbit, avoided, central_x }
 */
function bestCaptionPlacement(opts = {}) {
  const platform = String(opts.platform || "youtube").toLowerCase();
  const ui = PLATFORM_UI[platform] || PLATFORM_UI.youtube;
  const frameH = opts.frameH || 1920;
  const facecam = opts.facecam && opts.facecam.bounds ? opts.facecam : null;

  // Forbidden vertical bands in the central caption column.
  const forbidden = [];
  if (facecam) forbidden.push([facecam.bounds.y, facecam.bounds.y + facecam.bounds.height]);
  forbidden.push(ACTION_CENTER);
  for (const z of ui) { const cx = z.x + z.w / 2; if (cx > 0.12 && cx < 0.88) forbidden.push([z.y, z.y + z.h]); }

  const gaps = clearGaps(forbidden, 0.05, 0.95);
  if (!gaps.length) return { ok: false, reason: "no clear caption region", platform };

  // Orbit: place opposite the facecam. facecam top (or none) → lower captions.
  const camMidY = facecam ? facecam.bounds.y + facecam.bounds.height / 2 : 0;
  const camMidX = facecam ? facecam.bounds.x + facecam.bounds.width / 2 : 0.5;
  const preferLower = !facecam || camMidY < 0.5;

  let best = null;
  for (const [s, e] of gaps) {
    const h = e - s; if (h < 0.05) continue;
    const center = (s + e) / 2;
    const sideBonus = preferLower ? (center > 0.5 ? 1.18 : 0.82) : (center < 0.5 ? 1.18 : 0.82);
    const lowerThird = center > 0.6 && center < 0.84 ? 1.12 : 1.0; // caption convention
    const score = h * sideBonus * lowerThird;
    if (!best || score > best.score) best = { s, e, h, center, score };
  }
  if (!best) return { ok: false, reason: "no gap tall enough", platform };

  const bandH = Math.min(0.13, best.h);
  let y = preferLower ? Math.min(best.e - bandH, best.center) : Math.max(best.s, best.center - bandH / 2);
  y = Math.max(best.s, Math.min(best.e - bandH, y));

  const orbitFrom = facecam ? (facecam.position || facecam.corner || (camMidY < 0.5 ? "top" : "bottom")) : "none";
  return {
    ok: true,
    captionY: round3(y),
    captionHeight: round3(bandH),
    captionYpx: Math.round(y * frameH),
    central_x: CENTRAL_COLUMN,
    anchor: preferLower ? "lower" : "upper",
    orbit: `facecam ${orbitFrom} → captions ${preferLower ? "lower" : "upper"}`,
    avoided: { facecam: !!facecam, action_center: ACTION_CENTER, platform_ui: ui.map((z) => z.id), gameplay_zone: SAFE_GAMEPLAY_ZONE },
    facecamSide: facecam ? (camMidX < 0.4 ? "left" : camMidX > 0.6 ? "right" : "center") : null,
    platform,
  };
}

module.exports = { bestCaptionPlacement, clearGaps, PLATFORM_UI, SAFE_GAMEPLAY_ZONE, ACTION_CENTER };
