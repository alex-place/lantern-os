// Variant Engine V10 — generates 5 strategy variants (A-E) from a real analysis
// timeline, scores each with the V10 scorer, and ranks them.
//
// HONESTY: a variant is a SELECTION + ORDERING of real highlight segments from
// the analysis (a cut-list against the source). Each variant is scored by
// scoreVideoV10 on a derived sub-timeline built from the segments it actually
// contains — so every score reflects that specific edit. Nothing is random.
// (This replaces retention-engine.js, whose metrics used Math.random().)
//
// Spec: "V10 SCORING ENGINE REDESIGN" Phase 5.

"use strict";

const { scoreVideoV10 } = require("./score-v10");
const { dropoffPenalty } = require("../calibration/dropoff-model");

const STRATEGIES = {
  A: { id: "variantA", strategy: "maximum_retention", label: "Maximum Retention" },
  B: { id: "variantB", strategy: "maximum_excitement", label: "Maximum Excitement" },
  C: { id: "variantC", strategy: "maximum_rewatch", label: "Maximum Rewatch" },
  D: { id: "variantD", strategy: "story_arc", label: "Story Arc" },
  E: { id: "variantE", strategy: "balanced", label: "Balanced" },
};

const DEFAULT_TARGET_SEC = 35;
const MAX_TARGET_SEC = 55;

function round3(x) { return Number(Number(x).toFixed(3)); }
function segDur(h) { return Math.max(0, (h.end || 0) - (h.start || 0)); }
function excitement(h) {
  const multi = Array.isArray(h.tags) && h.tags.length >= 2 ? 1.3 : 1;
  return (h.score || 0) * multi;
}

/** Take highlights (sorted by `key` desc) until target duration is reached. */
function takeUntil(highlights, targetSec) {
  const picked = [];
  let total = 0;
  for (const h of highlights) {
    if (total >= targetSec && picked.length >= 2) break;
    picked.push(h);
    total += segDur(h);
    if (total >= MAX_TARGET_SEC) break;
  }
  return picked;
}

/** Select + order source segments for a strategy. Returns ordered segments. */
function selectSegments(highlights, strategy, targetSec) {
  if (!highlights.length) return [];
  const byScore = [...highlights].sort((a, b) => (b.score || 0) - (a.score || 0));
  const byExcite = [...highlights].sort((a, b) => excitement(b) - excitement(a));

  switch (strategy) {
    case "maximum_retention": {
      // Strongest moments, strongest first (instant hook), tightly packed.
      return takeUntil(byScore, targetSec);
    }
    case "maximum_excitement": {
      // Highest multi-signal intensity, ordered by intensity.
      return takeUntil(byExcite, targetSec);
    }
    case "maximum_rewatch": {
      // B1 hook-first + payoff-last: open with a strong hook (intro retention is
      // the #1 lever), build through the weakest, end on the strongest moment.
      const chosen = takeUntil(byScore, targetSec);
      if (chosen.length <= 2) return [...chosen].sort((a, b) => (b.score || 0) - (a.score || 0));
      const asc = [...chosen].sort((a, b) => (a.score || 0) - (b.score || 0));
      const peak = asc[asc.length - 1];          // strongest -> last (payoff)
      const opener = asc[asc.length - 2];         // 2nd strongest -> strong hook first
      const middle = asc.slice(0, asc.length - 2); // remainder, ascending build
      return [opener, ...middle, peak];
    }
    case "story_arc": {
      // B1 cold open: strongest hook first, THEN the rest in chronological order
      // (a weak chronological opener tanks intro retention).
      const chosen = takeUntil(byScore, targetSec);
      if (chosen.length <= 1) return chosen;
      const hook = [...chosen].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      const rest = chosen.filter((h) => h !== hook).sort((a, b) => (a.start || 0) - (b.start || 0));
      return [hook, ...rest];
    }
    case "balanced":
    default: {
      // Strong hook first, strongest payoff last, the rest between.
      const chosen = takeUntil(byScore, targetSec);
      if (chosen.length <= 2) return chosen;
      const sorted = [...chosen].sort((a, b) => (b.score || 0) - (a.score || 0));
      const hook = sorted[0];
      const payoff = sorted[1];
      const middle = sorted.slice(2).sort((a, b) => (a.start || 0) - (b.start || 0));
      return [hook, ...middle, payoff];
    }
  }
}

/** Re-time selected source segments into a standalone clip starting at 0. */
function buildDerivedTimeline(segments) {
  const highlights = [];
  let cursor = 0;
  for (const s of segments) {
    const d = segDur(s);
    highlights.push({
      start: round3(cursor),
      end: round3(cursor + d),
      duration: round3(d),
      score: s.score || 0,
      tags: s.tags || [],
      reason: s.reason,
    });
    cursor += d;
  }
  return { duration: round3(cursor), highlights };
}

/**
 * Generate and rank the 5 variants.
 * @param {Object} analysis  HighlightTimeline.toJSON()-shaped
 * @param {Object} opts      { gaming, safeZones, cropPlan, targetSec }
 * @returns {{ variants: Array, basis, calibrated, generatedAt }}
 */
/**
 * Last-resort highlights so a variant can ALWAYS be built. If real detection
 * produced nothing, synthesize short evenly-spaced windows from the clip
 * duration. Explicitly tagged "fallback" — we never fabricate quality signals,
 * we only guarantee a renderable selection so the pipeline cannot dead-end.
 */
function fallbackHighlights(analysis) {
  const dur = Number(analysis.duration) || 0;
  if (dur <= 1.5) return [];
  const win = Math.min(12, Math.max(2, dur / 6));
  if (dur <= win * 2) {
    const d = Math.min(dur, 12);
    return [{ start: 0, end: round3(d), duration: round3(d), score: 0.5, tags: ["fallback"], reason: "fallback: whole clip (no signals)" }];
  }
  return [0.2, 0.5, 0.8].map((c) => {
    const start = Math.max(0, Math.min(dur * c - win / 2, dur - win));
    return { start: round3(start), end: round3(start + win), duration: round3(win), score: 0.5, tags: ["fallback"], reason: "fallback: sampled window (no signals)" };
  });
}

function generateVariantsV10(analysis = {}, opts = {}) {
  let highlights = Array.isArray(analysis.highlights) ? analysis.highlights : [];
  // HARD GUARANTEE: never build empty (or single-segment) variants. We aim for
  // at least 2 segments so a Short always has structure; if real highlights are
  // short, top up with explicitly-tagged fallback windows (never fabricating
  // quality — they score 0.5 and carry the "fallback" tag). Best-effort: a clip
  // too short to yield a 2nd window stays as-is.
  let usedFallback = false;
  const realCount = highlights.length;
  if (highlights.length < 2) {
    for (const f of fallbackHighlights(analysis)) {
      if (highlights.length >= 2) break;
      if (!highlights.some((h) => Math.abs((h.start || 0) - f.start) < 1)) highlights.push(f);
    }
    usedFallback = highlights.length > realCount;
  }
  const targetSec = Math.min(MAX_TARGET_SEC, opts.targetSec || DEFAULT_TARGET_SEC);

  const variants = Object.values(STRATEGIES).map((def) => {
    const segments = selectSegments(highlights, def.strategy, targetSec).map((s) => ({
      start: round3(s.start || 0),
      end: round3(s.end || 0),
      duration: round3(segDur(s)),
      score: round3(s.score || 0),
      tags: s.tags || [],
    }));
    const derived = buildDerivedTimeline(segments);
    const scored = scoreVideoV10(derived, opts);

    // B1: structural strength of the OPENING segment — a proxy for hook quality
    // and thus intro retention (the platform's #1 lever). NOT a calibrated
    // retention %; it is the real score of whatever segment opens this variant.
    const introStrength = segments.length ? round3(segments[0].score || 0) : 0;

    // B2: mean drop-off penalty over this variant's segments. 0 (no-op) unless a
    // CALIBRATED dropoffProfile is supplied (>=100 cliff-labeled outcomes) — so
    // editing decisions are unchanged until the operator's own data supports them.
    const dropPenalty = segments.length
      ? round3(segments.reduce((s, seg) => s + dropoffPenalty(seg, opts.dropoffProfile), 0) / segments.length)
      : 0;

    return {
      id: def.id,
      strategy: def.strategy,
      label: def.label,
      segments,                       // source cut-list (for rendering)
      durationSec: derived.duration,
      introStrength,                  // 0-1 structural hook-strength proxy
      dropoffPenalty: dropPenalty,    // 0 unless a calibrated profile is supplied
      score: scored.viral,
      gaming: scored.gaming || null,
      retention: scored.retention,
      editorGrade: scored.editorGrade,
      headline: scored.headline,
      renderPath: null,               // set once actually rendered
    };
  });

  // Rank by structural viral score (desc); ties broken by editor grade composite.
  // B2: when a CALIBRATED drop-off profile is supplied, discount each variant's
  // rank key by its drop-off penalty (favoring edits that hold a flat curve).
  // Without a calibrated profile this is identical to the prior pure-score rank.
  const calibratedDropoff = !!(opts.dropoffProfile && opts.dropoffProfile.status === "ok");
  const rankKey = (v) => calibratedDropoff
    ? v.score.viralScore * (1 - 0.3 * v.dropoffPenalty)
    : v.score.viralScore;
  variants.sort((a, b) => (rankKey(b) - rankKey(a)) || (b.editorGrade.composite - a.editorGrade.composite));
  variants.forEach((v, i) => { v.rank = i + 1; });

  return {
    variants,
    basis: "structural_heuristic",
    calibrated: false,
    usedFallback,
    note: usedFallback
      ? "No highlights detected; variants built from fallback windows so render never dead-ends."
      : "Each variant is a real cut-list of analyzed segments; scores reflect the selected segments. renderPath is null until the variant is rendered.",
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { generateVariantsV10, selectSegments, buildDerivedTimeline, fallbackHighlights, STRATEGIES };
