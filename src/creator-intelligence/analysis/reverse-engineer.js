// Creator Intelligence — reverse-engineer report
// Computes hook / caption / camera / timing distributions over the rows that
// ACTUALLY EXIST. With an empty (or below-threshold) dataset it returns
// insufficient_data — it never hardcodes "best cut rate = X".
//
// See docs/creator-v10/creator-intelligence-architecture.md (feature flags + research report)

"use strict";

const store = require("../dataset/dataset-store");
const { MIN_ROWS_FOR_DISTRIBUTION } = require("../scoring/score-engine");

function mean(nums) {
  const v = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
}

function median(nums) {
  const v = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function distribution(rows, key) {
  const counts = {};
  for (const r of rows) {
    const val = r[key];
    if (val === undefined || val === null) continue;
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

/**
 * Build the viral-editing report from existing rows.
 * @returns {Object} report OR { status:'insufficient_data', have, need }
 */
function reverseEngineer(opts = {}) {
  const need = opts.minRows || MIN_ROWS_FOR_DISTRIBUTION;
  const rows = [...store.readAll("general"), ...store.readAll("gaming")];
  const have = rows.length;

  if (have < need) {
    return {
      status: "insufficient_data",
      reason: "not enough collected rows to characterize viral editing",
      have,
      need,
    };
  }

  // Weight averages toward higher-view rows so "what performs" reflects reality,
  // but only over rows that actually carry the field.
  const withViews = rows.filter((r) => typeof r.viewCount === "number");
  const topQuartile = [...withViews]
    .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
    .slice(0, Math.max(1, Math.floor(withViews.length / 4)));

  return {
    status: "ok",
    basis: { datasetSize: have, topQuartileSize: topQuartile.length, computedAt: new Date().toISOString() },
    hookStyles: distribution(rows, "hookStyle"),
    timing: {
      cutFrequency: { mean: mean(rows.map((r) => r.cutFrequency)), median: median(rows.map((r) => r.cutFrequency)),
                      topQuartileMean: mean(topQuartile.map((r) => r.cutFrequency)) },
      hookLength: { mean: mean(rows.map((r) => r.hookLength)),
                    topQuartileMean: mean(topQuartile.map((r) => r.hookLength)) },
      duration: { mean: mean(rows.map((r) => r.duration)), median: median(rows.map((r) => r.duration)) },
    },
    captions: {
      captionDensity: { mean: mean(rows.map((r) => r.captionDensity)),
                        topQuartileMean: mean(topQuartile.map((r) => r.captionDensity)) },
    },
    camera: {
      zoomFrequency: { mean: mean(rows.map((r) => r.zoomFrequency)),
                       topQuartileMean: mean(topQuartile.map((r) => r.zoomFrequency)) },
    },
    music: { presenceRate: presenceRate(rows, "musicPresence") },
  };
}

function presenceRate(rows, key) {
  const known = rows.filter((r) => typeof r[key] === "boolean");
  if (!known.length) return null;
  return known.filter((r) => r[key]).length / known.length;
}

module.exports = { reverseEngineer };
