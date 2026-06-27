// Creator Intelligence — editing recommendations
// Per-video suggestions derived from REAL analysis output (HighlightTimeline,
// SafeZones, events) plus, when available, population scoring. Population-based
// confidence is reported honestly: if there's no dataset, recommendations are
// labeled "heuristic (no performance data yet)" rather than dressed up as
// data-backed predictions.

"use strict";

const scoring = require("../scoring/score-engine");

/**
 * @param {Object} analysis  per-video analysis: { highlights[], duration, events?, safeZones? }
 * @returns {{ recommendations: Array, scoreContext: object }}
 */
function forVideo(analysis = {}) {
  const recs = [];
  const highlights = Array.isArray(analysis.highlights) ? analysis.highlights : [];
  const duration = Number(analysis.duration) || 0;

  // --- Per-video, always-real recommendations (derived from this clip only) ---

  if (highlights.length === 0) {
    recs.push({
      kind: "highlights",
      basis: "per_video",
      message: "No strong highlights detected. Consider a tighter source clip or lower detection thresholds.",
    });
  } else {
    const top = [...highlights].sort((a, b) => b.score - a.score)[0];
    recs.push({
      kind: "hook",
      basis: "per_video",
      message: `Strongest moment is at ${top.start}s (score ${top.score}). Open on it for an instant-payoff hook.`,
      evidence: { start: top.start, end: top.end, score: top.score, reason: top.reason },
    });
  }

  if (duration > 60) {
    recs.push({
      kind: "duration",
      basis: "per_video",
      message: `Source is ${duration.toFixed(0)}s. Short-form target is 5-60s; trim to the top highlights.`,
    });
  }

  // --- Population-based recommendation (only if dataset supports it) ---

  const features = analysis.features || {};
  const viral = scoring.viralScore(features);
  if (viral.status === "ok") {
    recs.push({
      kind: "pacing",
      basis: "population",
      message: `Edit features score ${viral.value} vs top performers (n=${viral.basis.datasetSize}).`,
      score: viral.value,
    });
  } else {
    recs.push({
      kind: "pacing",
      basis: "heuristic",
      message: "No performance dataset yet — pacing advice is heuristic, not data-backed.",
      insufficientData: { have: viral.have, need: viral.need },
    });
  }

  return {
    recommendations: recs,
    scoreContext: { viral, retention: scoring.retentionScore(features) },
  };
}

module.exports = { forVideo };
