"use strict";
/**
 * Convergence Replay / time-travel debugger (#1419).
 *
 * "git-bisect for an agent's reasoning": replay any stretch of the agent's past
 * convergence records step-by-step — hypothesis → evidence → result → confidence — and
 * scrub the timeline to see where confidence shifted or a verdict flipped. Purely
 * additive over the ConvergenceRecord JSONL we already append (data/convergence/records.jsonl).
 *
 * Pure timeline/state builders (no I/O), so the stepping + regression-detection logic is
 * deterministic and testable.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

function _num(x) { return typeof x === "number" && Number.isFinite(x) ? x : null; }
function _ts(r) { return Date.parse(r && (r.timestamp || r.ts || r.recordedAt)) || 0; }

// One record → a normalized replay step.
function normalizeStep(r, i) {
  const conf = _num(r.confidence);
  return {
    i,
    ts: r.timestamp || r.ts || r.recordedAt || null,
    reasoner: r.reasoner || r.agent || r.source || "unknown",
    hypothesis: String(r.hypothesis || r.claim || r.text || r.title || "(no hypothesis)").slice(0, 400),
    evidence: Array.isArray(r.evidence_ids) ? r.evidence_ids.join(", ")
      : String(r.evidence || r.verification_notes || "").slice(0, 400),
    result: String(r.result || "").slice(0, 200),
    verified: r.verified === true ? true : (r.verified === false ? false : null),
    confidence: conf,
  };
}

// Build the ordered timeline with per-step confidence delta vs the previous step.
function buildTimeline(records, { reasoner } = {}) {
  let rs = (records || []).filter((r) => r && typeof r === "object");
  if (reasoner) rs = rs.filter((r) => (r.reasoner || r.agent || r.source) === reasoner);
  rs = rs.slice().sort((a, b) => _ts(a) - _ts(b));
  const steps = rs.map(normalizeStep);
  let prevConf = null;
  for (const s of steps) {
    s.delta = (s.confidence != null && prevConf != null) ? Math.round((s.confidence - prevConf) * 1000) / 1000 : null;
    if (s.confidence != null) prevConf = s.confidence;
  }
  return steps;
}

// State at a given scrub position: the current step, progress, and the confidence
// trajectory up to here (for the sparkline + "shifts so far").
function replayState(timeline, index) {
  const n = timeline.length;
  if (n === 0) return { index: 0, total: 0, step: null, trajectory: [], progress: 0 };
  const idx = Math.max(0, Math.min(n - 1, index | 0));
  return {
    index: idx, total: n, step: timeline[idx],
    progress: n > 1 ? idx / (n - 1) : 1,
    trajectory: timeline.slice(0, idx + 1).map((s) => s.confidence),
  };
}

// "git-bisect" candidates: steps where the verdict flipped to refuted/false or confidence
// dropped sharply — the places to inspect first when reasoning went wrong.
function findRegressions(timeline, { dropThreshold = 0.25 } = {}) {
  const out = [];
  for (const s of timeline) {
    const sharpDrop = s.delta != null && s.delta <= -dropThreshold;
    const flippedFalse = s.verified === false;
    const refuted = /\b(refut|fail|false|incorrect|apply_failed)\b/i.test(s.result);
    if (sharpDrop || flippedFalse || refuted) {
      out.push({ i: s.i, ts: s.ts, reasoner: s.reasoner, hypothesis: s.hypothesis,
        reason: sharpDrop ? `confidence dropped ${s.delta}` : (flippedFalse ? "verdict flipped to unverified" : "result reads as refuted/failed") });
    }
  }
  return out;
}

function reasoners(timeline) {
  return [...new Set(timeline.map((s) => s.reasoner))].sort();
}

function readRecords(root) {
  const f = path.join(root || DEFAULT_REPO_ROOT, "data", "convergence", "records.jsonl");
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { normalizeStep, buildTimeline, replayState, findRegressions, reasoners, readRecords };
