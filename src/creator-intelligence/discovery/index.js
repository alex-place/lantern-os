// Editing Discovery Engine — orchestrator
// One always-honest pass of the discovery loop over a set of clips the operator
// ACTUALLY HAS (own renders/uploads + curated reference set): segment → mine
// recurring edit patterns → build a playbook. Performance/verification is sourced
// only from real first-party outcomes (the calibration store); with none, the
// playbook is structural and every technique reads insufficient_data.
//
// This is the consumer of the calibration loop — it discovers/clusters now and
// "verifies" as real outcomes arrive. It never scrapes other creators' private
// replay/share metrics (no API exposes them; inventing them is forbidden).
//
// See docs/creator-v10/ (editing discovery engine)

"use strict";

const fs = require("fs");
const path = require("path");

const { segmentClip } = require("./segment");
const { minePatterns } = require("./pattern-mining");
const { buildPlaybook } = require("./playbook");

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Pure discovery pass.
 * @param {Array} clips  [{ id, analysis }] — analysis = HighlightTimeline.toJSON()-shape
 * @param {Object} opts  { outcomesByClipId?, metricName?, minClips?, limit? }
 */
function discoverFromClips(clips, opts = {}) {
  const segments = (Array.isArray(clips) ? clips : []).map(segmentClip);
  const mining = minePatterns(segments, opts);
  const playbook = buildPlaybook(mining.patterns, opts);
  return {
    clips: segments.length,
    labeledClips: mining.labeledClips,
    patterns: mining.patterns,
    playbook,
    note: mining.labeledClips === 0
      ? "Structural discovery only — no labeled outcomes yet, so every technique is insufficient_data. Import first-party analytics to unlock verification."
      : "Performance computed from labeled outcomes where available; still gated per technique.",
  };
}

// --- best-effort disk loaders (decoupled; core stays pure) -------------------

/** Load analyzed clips from data/creator/entries/<id>/ (analysis.json or metadata.scoreV10). */
function loadAnalyzedClips() {
  const dir = path.join(repoRoot(), "data", "creator", "entries");
  if (!fs.existsSync(dir)) return [];
  const clips = [];
  for (const d of fs.readdirSync(dir)) {
    const base = path.join(dir, d);
    let analysis = null;
    const aPath = path.join(base, "analysis.json");
    const mPath = path.join(base, "metadata.json");
    try {
      if (fs.existsSync(aPath)) {
        const a = JSON.parse(fs.readFileSync(aPath, "utf8"));
        analysis = a.timeline || a; // tolerate either shape
      } else if (fs.existsSync(mPath)) {
        const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
        // Fall back to whatever timeline-ish data the entry carries.
        analysis = m.analysis && m.analysis.timeline ? m.analysis.timeline : null;
      }
    } catch { /* skip unreadable */ }
    if (analysis && Array.isArray(analysis.highlights)) clips.push({ id: d, analysis });
  }
  return clips;
}

/** Map entryId → a single performance metric from the calibration outcome store. */
function loadOutcomesByClipId(metricName = "avgPercentViewed") {
  let store;
  try { store = require("../calibration/outcome-store"); } catch { return {}; }
  const out = {};
  for (const row of store.readAll()) {
    if (row.entryId && row.outcome && typeof row.outcome[metricName] === "number") {
      out[row.entryId] = row.outcome[metricName]; // latest wins
    }
  }
  return out;
}

/** Full pass over what's on disk. */
function discoverFromDisk(opts = {}) {
  const metricName = opts.metricName || "avgPercentViewed";
  return discoverFromClips(loadAnalyzedClips(), {
    ...opts, metricName, outcomesByClipId: loadOutcomesByClipId(metricName),
  });
}

module.exports = {
  discoverFromClips, discoverFromDisk, loadAnalyzedClips, loadOutcomesByClipId,
  segmentClip, minePatterns, buildPlaybook,
};
