// Editing Discovery Engine — segmentation + role labeling
// Turns a clip's measured analysis (HighlightTimeline.toJSON + metadata) into an
// ordered sequence of "beats" with editing ROLES, so recurring edit sequences can
// be mined into named techniques. Pure + testable.
//
// HONESTY: roles are derived ONLY from measured signals (A1 cuts, A2 novel tag,
// A3 speech hook/CTA, A4 retention). Nothing is invented; a beat with no usable
// signal is just "build".
//
// See docs/creator-v10/ (editing discovery engine)

"use strict";

// Time buckets from the spec (seconds): 0-1, 1-3, 3-7, 7-15, 15+.
const BUCKETS = [
  { name: "0-1s", max: 1 },
  { name: "1-3s", max: 3 },
  { name: "3-7s", max: 7 },
  { name: "7-15s", max: 15 },
  { name: "15s+", max: Infinity },
];
const HOOK_SEC = 3;          // a beat starting before this is in the hook window
const PAYOFF_LATE_FRAC = 0.8; // a strong beat in the last 20% is a payoff

function timeBucket(t) {
  for (const b of BUCKETS) if (t < b.max) return b.name;
  return "15s+";
}

/**
 * Label one highlight with an editing role from measured signals.
 * @param {Object} h     highlight { start, end, score, tags[] }
 * @param {number} duration
 * @param {Object} speech  metadata.speech (A3) or null
 */
function roleFor(h, duration, speech) {
  const tags = Array.isArray(h.tags) ? h.tags : [];
  // CTA: A3 detected a call-to-action whose timestamp falls inside this beat.
  if (speech && speech.measured && speech.ctaPresent &&
      typeof speech.ctaTimeSec === "number" &&
      speech.ctaTimeSec >= h.start && speech.ctaTimeSec <= (h.end ?? h.start)) {
    return "cta";
  }
  // Hook: opens the clip.
  if (h.start < HOOK_SEC) return "hook";
  // Payoff: a strong beat in the final stretch.
  if (duration > 0 && h.start >= PAYOFF_LATE_FRAC * duration && (h.score || 0) >= 0.5) return "payoff";
  // Surprise: a recurrence-novel or multi-signal spike.
  if (tags.includes("novel") || tags.length >= 2) return "surprise";
  return "build";
}

/** Collapse consecutive identical roles so a sequence reflects TRANSITIONS. */
function collapseRuns(roles) {
  const out = [];
  for (const r of roles) if (out[out.length - 1] !== r) out.push(r);
  return out;
}

/**
 * Segment a clip into role-labeled beats + a collapsed role sequence.
 * @param {Object} clip  { id?, analysis: {duration, highlights[], metadata{speech}} }
 * @returns {{ id, duration, beats:Array, roleSequence:string[] }}
 */
function segmentClip(clip) {
  const analysis = (clip && clip.analysis) || clip || {};
  const id = (clip && clip.id) || analysis.id || null;
  const highlights = Array.isArray(analysis.highlights) ? [...analysis.highlights] : [];
  highlights.sort((a, b) => (a.start || 0) - (b.start || 0));
  const duration = Number(analysis.duration) ||
    (highlights.length ? Math.max(...highlights.map((h) => h.end || 0)) : 0);
  const speech = analysis.metadata && analysis.metadata.speech;

  const beats = highlights.map((h) => ({
    t: Number((h.start || 0).toFixed(2)),
    bucket: timeBucket(h.start || 0),
    role: roleFor(h, duration, speech),
    tags: Array.isArray(h.tags) ? h.tags : [],
  }));

  return { id, duration, beats, roleSequence: collapseRuns(beats.map((b) => b.role)) };
}

module.exports = { segmentClip, timeBucket, roleFor, collapseRuns, BUCKETS, HOOK_SEC };
