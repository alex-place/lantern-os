// Editing Discovery Engine — pattern discovery
// Mines recurring edit-role sub-sequences across many segmented clips (e.g.
// "hook → surprise → payoff"), counts how many clips share each, and reports
// performance ONLY when enough of those clips carry real first-party outcomes.
// Pure + testable.
//
// HONESTY: a pattern is "discovered" structurally (frequency) but its performance
// stays insufficient_data until enough outcome-labeled examples exist — then
// directional, then calibrated. Frequency != performance; never conflated.
//
// See docs/creator-v10/ (editing discovery engine)

"use strict";

// Discovery thresholds (conservative). Distinct from the population calibration
// floors (30/100) — these are per-pattern example counts.
const MIN_CLIPS_FOR_PATTERN = 3;       // appears in >=3 clips to be a "pattern"
const MIN_LABELED_FOR_DIRECTIONAL = 5; // outcome-labeled examples for a directional read
const MIN_LABELED_FOR_CALIBRATED = 20; // ...and for a calibrated read
const MIN_LEN = 2;
const MAX_LEN = 4;

// Friendly names for well-known role sequences; otherwise a generic arrow-join.
const TEMPLATE_NAMES = {
  "hook>build>surprise>payoff": "Delayed Reveal",
  "hook>surprise>payoff": "Quick Payoff",
  "hook>build>payoff": "Setup → Payoff",
  "hook>payoff>cta": "Hook · Payoff · CTA",
  "surprise>payoff": "Spike → Payoff",
  "hook>surprise": "Cold-Open Surprise",
};

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function nameSequence(roles) {
  const key = roles.join(">");
  if (TEMPLATE_NAMES[key]) return TEMPLATE_NAMES[key];
  return roles.map(titleCase).join(" → ");
}

/** All contiguous sub-sequences of `seq` with length in [MIN_LEN, MAX_LEN]. */
function subsequences(seq, minLen = MIN_LEN, maxLen = MAX_LEN) {
  const out = [];
  for (let len = minLen; len <= Math.min(maxLen, seq.length); len++) {
    for (let i = 0; i + len <= seq.length; i++) out.push(seq.slice(i, i + len));
  }
  return out;
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

/**
 * @param {Array} segmentedClips  output of segmentClip() per clip (need id + roleSequence)
 * @param {Object} opts
 *   - outcomesByClipId?: { [clipId]: number }  a single performance metric per clip
 *     (e.g. avgPercentViewed). Performance is computed ONLY from these.
 *   - minClips?, metricName?
 * @returns {{ patterns: Array, clips: number, labeledClips: number }}
 */
function minePatterns(segmentedClips, opts = {}) {
  const minClips = opts.minClips || MIN_CLIPS_FOR_PATTERN;
  const outcomes = opts.outcomesByClipId || {};
  const metricName = opts.metricName || "performance";

  // clipIds that share each sub-sequence key.
  const byKey = new Map();
  for (const clip of segmentedClips) {
    const seq = Array.isArray(clip.roleSequence) ? clip.roleSequence : [];
    const seen = new Set(); // count each clip once per distinct sub-sequence
    for (const sub of subsequences(seq)) {
      const key = sub.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byKey.has(key)) byKey.set(key, { roles: sub, clipIds: [] });
      byKey.get(key).clipIds.push(clip.id);
    }
  }

  const patterns = [];
  for (const [key, { roles, clipIds }] of byKey) {
    if (clipIds.length < minClips) continue;

    // Performance: only from example clips that carry a real outcome.
    const labeled = clipIds.filter((id) => typeof outcomes[id] === "number");
    let performance;
    if (labeled.length >= MIN_LABELED_FOR_DIRECTIONAL) {
      const vals = labeled.map((id) => outcomes[id]);
      performance = {
        status: "ok",
        calibrated: labeled.length >= MIN_LABELED_FOR_CALIBRATED,
        basis: labeled.length >= MIN_LABELED_FOR_CALIBRATED ? "calibrated" : "directional",
        metric: metricName,
        avg: Number(mean(vals).toFixed(4)),
        n: labeled.length,
      };
    } else {
      performance = { status: "insufficient_data", have: labeled.length, need: MIN_LABELED_FOR_DIRECTIONAL };
    }

    patterns.push({
      id: "pat-" + key.replace(/>/g, "_"),
      sequence: roles,
      label: nameSequence(roles),
      frequency: clipIds.length,                 // # of clips that contain it (structural)
      exampleClipIds: clipIds.slice(0, 8),
      performance,
      // Confidence is STRUCTURAL: how consistently we've SEEN it, not that it works.
      structuralConfidence: Number(Math.min(1, clipIds.length / (minClips * 4)).toFixed(3)),
    });
  }

  // Rank by frequency, then length (longer/more-specific sequences first on ties).
  patterns.sort((a, b) => (b.frequency - a.frequency) || (b.sequence.length - a.sequence.length));

  const labeledClips = segmentedClips.filter((c) => typeof outcomes[c.id] === "number").length;
  return { patterns, clips: segmentedClips.length, labeledClips };
}

module.exports = {
  minePatterns, nameSequence, subsequences,
  MIN_CLIPS_FOR_PATTERN, MIN_LABELED_FOR_DIRECTIONAL, MIN_LABELED_FOR_CALIBRATED, TEMPLATE_NAMES,
};
