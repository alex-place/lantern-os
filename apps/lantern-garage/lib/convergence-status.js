"use strict";
// Convergence loop status — the Converge stage made visible to the chat UX.
//
// Reads the append-only ConvergenceRecord log that dream-chat / unisona.ai replies
// emit (data/convergence/records.jsonl) plus any compiled patterns
// (data/convergence/patterns.jsonl, written by scripts/convergence_close_loop.py)
// and returns a compact live summary for the dream-chat observability panel.
// Read-only; never throws (returns a zeroed summary on any failure).

const path = require("path");
const { RECORDS_PATH } = require("./convergence-records");
const { readJsonlCached } = require("./jsonl-cache");

const PATTERNS_PATH = path.resolve(__dirname, "..", "..", "..", "data/convergence/patterns.jsonl");

// mtime-cached: both logs are append-only, so a status poll that hasn't seen a
// new record re-uses the parsed array instead of re-reading the files (#1890).
function readJsonl(p) {
  return readJsonlCached(p);
}

// Aggregate the record log into the loop's live state.
function convergenceStatus() {
  const records = readJsonl(RECORDS_PATH);
  const total = records.length;
  const byReasoner = {};
  let confSum = 0, grounded = 0, verified = 0;

  for (const r of records) {
    const c = Math.max(0, Math.min(1, Number(r.confidence) || 0));
    confSum += c;
    if (c >= 0.6) grounded += 1;           // grounded = trusted (online) reasoning
    if (r.verified) verified += 1;          // graded by the Verify stage
    const k = r.reasoner || "unknown";
    if (!byReasoner[k]) byReasoner[k] = { count: 0, confSum: 0 };
    byReasoner[k].count += 1;
    byReasoner[k].confSum += c;
  }

  const reasoners = Object.entries(byReasoner)
    .map(([reasoner, v]) => ({ reasoner, count: v.count, avgConfidence: v.count ? v.confSum / v.count : 0 }))
    .sort((a, b) => b.count - a.count);

  const patterns = readJsonl(PATTERNS_PATH);

  return {
    total,
    avgConfidence: total ? confSum / total : 0,
    groundedPct: total ? grounded / total : 0,
    verified,
    reasoners,
    topReasoner: reasoners[0] ? reasoners[0].reasoner : null,
    patternsCount: patterns.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { convergenceStatus, PATTERNS_PATH };
