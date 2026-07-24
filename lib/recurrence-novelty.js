// Lantern — unsupervised audio-visual recurrence novelty (A2)
// Scores each time-window by how far it stands out from the clip's OWN typical
// window. Label-free / self-supervised: "typical" is the clip's robust center,
// and a highlight is a window that deviates from it in the salient (high-energy)
// direction. This replaces "max(motion, audio, scene)" with a novelty signal
// (recurrence): a loud-but-repeated moment scores like the rest, a genuinely
// surprising one stands out.
//
// HONESTY: scores are RELATIVE within this one clip and computed from real
// measured signals. A uniform clip yields ~zero novelty everywhere — we never
// manufacture contrast (no min-max stretching). <4 windows => no scores (you
// can't define "typical" from almost nothing).
//
// See docs/creator-v10/editing-analysis-model-research.md (A2)

"use strict";

const Z_SAT = 3;        // RMS of robust z-scores at which novelty saturates to 1
const MIN_WINDOWS = 4;  // need enough windows to define a "typical" baseline

function round3(x) { return Number(Number(x).toFixed(3)); }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(arr, med) {
  if (!arr.length) return 0;
  return median(arr.map((x) => Math.abs(x - med)));
}

/**
 * Per-window novelty in [0,1]. Each window: { t:number, vec:{key:number,...} }.
 * Features are treated as "higher = more salient" — only POSITIVE deviations
 * above the clip's median count (a quiet/still window is not a highlight).
 * @returns {Array<{t:number, novelty:number}>}  empty if too few windows
 */
function noveltyScores(windows) {
  if (!Array.isArray(windows) || windows.length < MIN_WINDOWS) return [];

  // Feature dimensions present anywhere.
  const keys = new Set();
  for (const w of windows) {
    if (w && w.vec) for (const k of Object.keys(w.vec)) if (isNum(w.vec[k])) keys.add(k);
  }

  // Robust center + scale per dimension; drop dimensions with no variation.
  const stats = {};
  for (const k of keys) {
    const vals = windows.map((w) => (w.vec ? w.vec[k] : undefined)).filter(isNum);
    const med = median(vals);
    const scale = 1.4826 * mad(vals, med); // MAD → ~std for normal data
    if (scale > 1e-9) stats[k] = { med, scale };
  }
  const usable = Object.keys(stats);

  return windows.map((w) => {
    let sumsq = 0, n = 0;
    for (const k of usable) {
      const v = w.vec ? w.vec[k] : undefined;
      if (!isNum(v)) continue;
      const z = Math.max(0, (v - stats[k].med) / stats[k].scale); // salient direction only
      sumsq += z * z; n++;
    }
    const rms = n ? Math.sqrt(sumsq / n) : 0;
    return { t: w.t, novelty: round3(Math.max(0, Math.min(1, rms / Z_SAT))) };
  });
}

/**
 * Merge windows whose novelty clears `threshold` into candidate highlight spans.
 * Returns [] honestly when nothing stands out.
 * @param {Array<{t,vec}>} windows
 * @param {number} windowSec  width of each window
 * @param {Object} opts        { threshold=0.5 }
 * @returns {Array<{start,end,novelty,reason}>}
 */
function recurrenceHighlights(windows, windowSec, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const scores = noveltyScores(windows);
  if (!scores.length || !isNum(windowSec) || windowSec <= 0) return [];

  const spans = [];
  let cur = null;
  for (const s of scores) {
    if (s.novelty >= threshold) {
      if (cur && s.t - cur.end <= windowSec * 1.5) {
        cur.end = s.t + windowSec;
        cur.peak = Math.max(cur.peak, s.novelty);
      } else {
        if (cur) spans.push(cur);
        cur = { start: s.t, end: s.t + windowSec, peak: s.novelty };
      }
    }
  }
  if (cur) spans.push(cur);

  return spans.map((sp) => ({
    start: round3(sp.start),
    end: round3(sp.end),
    novelty: round3(sp.peak),
    reason: "recurrence_novelty",
  }));
}

/**
 * Bin raw per-frame signal series into windows with aggregated salient features.
 * @param {{motion?:Array,audio?:Array,scene?:Array}} series  frame arrays with
 *   {timestamp, motion} / {timestamp, loudness} / {timestamp, difference}
 * @param {number} durationSec
 * @param {number} windowSec
 * @returns {Array<{t, vec:{motion,loudness,scene}}>}
 */
function framesToWindows(series, durationSec, windowSec = 2) {
  if (!isNum(durationSec) || durationSec <= 0 || !isNum(windowSec) || windowSec <= 0) return [];
  const nWin = Math.max(1, Math.ceil(durationSec / windowSec));
  const bins = Array.from({ length: nWin }, (_, i) => ({
    t: round3(i * windowSec), motionSum: 0, motionN: 0, loudSum: 0, loudN: 0, sceneCount: 0,
  }));
  const idx = (ts) => Math.min(nWin - 1, Math.max(0, Math.floor(ts / windowSec)));

  for (const f of series.motion || []) if (isNum(f.timestamp) && isNum(f.motion)) { const b = bins[idx(f.timestamp)]; b.motionSum += f.motion; b.motionN++; }
  for (const f of series.audio || []) if (isNum(f.timestamp) && isNum(f.loudness)) { const b = bins[idx(f.timestamp)]; b.loudSum += f.loudness; b.loudN++; }
  for (const f of series.scene || []) if (isNum(f.timestamp)) bins[idx(f.timestamp)].sceneCount++;

  return bins.map((b) => ({
    t: b.t,
    vec: {
      motion: b.motionN ? b.motionSum / b.motionN : 0,
      loudness: b.loudN ? b.loudSum / b.loudN : 0,
      scene: b.sceneCount,
    },
  }));
}

module.exports = { noveltyScores, recurrenceHighlights, framesToWindows, MIN_WINDOWS, Z_SAT };
