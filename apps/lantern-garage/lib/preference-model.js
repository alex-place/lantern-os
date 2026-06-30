"use strict";
/**
 * Retrieval-based personal preference model (#1426).
 *
 * Learns the USER's taste (not the internet's) from their accept/reject decisions and
 * re-ranks future candidates — no retraining. Each decision is a convergence record:
 * an item described by features/tags, plus whether the user accepted it. From those we
 * tally a per-feature preference weight and score new items by the features they carry.
 *
 * Pure math (no I/O), so learning + scoring + ranking are deterministic and testable.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

function normFeatures(features) {
  return [...new Set((Array.isArray(features) ? features : [])
    .map((f) => String(f || "").trim().toLowerCase()).filter(Boolean))];
}

// Per-feature preference weight in (-1, 1): (accepts - rejects) / (accepts + rejects + 1).
// The +1 (Laplace) keeps a single observation from swinging to ±1, so weak evidence stays
// weak. `support` = how many decisions touched the feature (confidence in the weight).
function learnWeights(decisions) {
  const stat = {};
  for (const d of decisions || []) {
    if (!d) continue;
    const accepted = !!d.accepted;
    for (const f of normFeatures(d.features)) {
      const s = (stat[f] = stat[f] || { acc: 0, rej: 0 });
      if (accepted) s.acc += 1; else s.rej += 1;
    }
  }
  const weights = {};
  for (const [f, s] of Object.entries(stat)) {
    weights[f] = { weight: (s.acc - s.rej) / (s.acc + s.rej + 1), support: s.acc + s.rej, acc: s.acc, rej: s.rej };
  }
  return weights;
}

// Predicted preference for an item: sum of the learned weights of the features it carries
// (unknown features contribute 0 — neutral). Liked features lift it, disliked sink it.
function scoreItem(features, weights) {
  let score = 0;
  for (const f of normFeatures(features)) if (weights[f]) score += weights[f].weight;
  return Math.round(score * 1000) / 1000;
}

// Why an item scored as it did: its features by contribution magnitude.
function explain(features, weights) {
  return normFeatures(features)
    .map((f) => ({ feature: f, weight: weights[f] ? weights[f].weight : 0, support: weights[f] ? weights[f].support : 0 }))
    .filter((x) => x.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

// Re-rank candidates [{id, features, ...}] by predicted preference, attaching score +
// the top reasons (so the ranking is explainable, not a black box).
function rankItems(candidates, weights) {
  return (candidates || []).map((c) => ({
    ...c,
    score: scoreItem(c.features, weights),
    reasons: explain(c.features, weights).slice(0, 3),
  })).sort((a, b) => b.score - a.score);
}

// Whole-model summary: strongest likes/dislikes for the UI.
function tasteProfile(weights, n = 6) {
  const arr = Object.entries(weights).map(([feature, w]) => ({ feature, ...w }));
  return {
    likes: arr.filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, n),
    dislikes: arr.filter((x) => x.weight < 0).sort((a, b) => a.weight - b.weight).slice(0, n),
    features: arr.length,
  };
}

// ── thin JSONL persistence ──────────────────────────────────────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "preferences", "decisions.jsonl"); }
function readDecisions(root) {
  try {
    return fs.readFileSync(_file(root), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function recordDecision(root, input, nowIso) {
  const features = normFeatures(input.features);
  if (!features.length) throw new Error("at least one feature/tag is required");
  const decision = {
    id: `pref:${crypto.randomUUID()}`,
    item: String(input.item || "").slice(0, 300),
    features, accepted: !!input.accepted, ts: nowIso,
  };
  const f = _file(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(decision) + "\n");
  return decision;
}

module.exports = {
  normFeatures, learnWeights, scoreItem, explain, rankItems, tasteProfile,
  readDecisions, recordDecision,
};
