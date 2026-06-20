// Creator Intelligence — drop-off-aware cutting model (B2)
// Learns, from the operator's OWN labeled outcomes, which segment types tend to
// precede a retention cliff (A4 attributes each cliff to the edit segment it lands
// in). The editing model can then penalize segments resembling those drop-off-prone
// types. STRICTLY gated: until enough cliff-labeled outcomes exist, the profile is
// insufficient_data and the penalty is a flat 0 — editing decisions stay exactly as
// they were (no calibrated cut is made before the data supports it).
//
// HONESTY: penalties derive only from real attributed cliffs; no profile => 0.
//
// See docs/creator-v10/editing-analysis-model-research.md (B2)

"use strict";

const { MIN_FOR_CALIBRATION } = require("./calibration-engine");

function round3(x) { return Number(Number(x).toFixed(3)); }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

/**
 * A usable cliff-labeled outcome row carries `cliffSegment.tags` (the tags of the
 * edit segment the drop-off was attributed to) and a cliff magnitude in [0,1]
 * (cliffSegment.drop, falling back to outcome.maxCliffDrop).
 */
function cliffDrop(row) {
  if (row.cliffSegment && isNum(row.cliffSegment.drop)) return row.cliffSegment.drop;
  if (row.outcome && isNum(row.outcome.maxCliffDrop)) return row.outcome.maxCliffDrop;
  return null;
}
function usableRow(row) {
  return !!(row && row.cliffSegment && Array.isArray(row.cliffSegment.tags) &&
            row.cliffSegment.tags.length > 0 && cliffDrop(row) !== null);
}

/**
 * Build a drop-off profile: per segment-tag, how much cumulative cliff magnitude
 * it has been associated with, normalized to a [0,1] penalty.
 * @returns insufficient_data OR
 *   { status:"ok", calibrated:true, tagPenalty:{tag:0..1}, sampleSize }
 */
function buildDropoffProfile(outcomeRows, opts = {}) {
  const need = opts.minRows || MIN_FOR_CALIBRATION;
  const rows = (Array.isArray(outcomeRows) ? outcomeRows : []).filter(usableRow);
  if (rows.length < need) {
    return { status: "insufficient_data", have: rows.length, need,
             reason: "not enough cliff-labeled outcomes for drop-off-aware cutting",
             tagPenalty: {} };
  }

  const weight = {};
  for (const r of rows) {
    const drop = cliffDrop(r);
    for (const tag of r.cliffSegment.tags) weight[tag] = (weight[tag] || 0) + drop;
  }
  const maxW = Math.max(...Object.values(weight), 0);
  const tagPenalty = {};
  if (maxW > 0) for (const [t, w] of Object.entries(weight)) tagPenalty[t] = round3(w / maxW);

  return { status: "ok", calibrated: true, tagPenalty, sampleSize: rows.length,
           computedAt: new Date().toISOString() };
}

/**
 * Penalty in [0,1] for a candidate segment given a profile. The riskiest tag the
 * segment carries drives the penalty. Returns 0 for an uncalibrated profile
 * (no-op) — the editing model is unchanged until the data exists.
 */
function dropoffPenalty(segment, profile) {
  if (!profile || profile.status !== "ok" || !profile.tagPenalty) return 0;
  const tags = (segment && Array.isArray(segment.tags)) ? segment.tags : [];
  let p = 0;
  for (const t of tags) if (isNum(profile.tagPenalty[t]) && profile.tagPenalty[t] > p) p = profile.tagPenalty[t];
  return round3(p);
}

module.exports = { buildDropoffProfile, dropoffPenalty, usableRow, MIN_FOR_CALIBRATION };
