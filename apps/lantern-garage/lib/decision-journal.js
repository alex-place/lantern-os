"use strict";
/**
 * Decisions, remembered and graded (#1436) — a Converge-stage consumer product.
 *
 * Log a real-life decision (job offer, move, purchase) as a hypothesis with a stated
 * confidence; months later record how it actually turned out. Over time the calibration
 * view answers the self-knowledge question: are your confident gut calls actually good,
 * or are you systematically over/under-confident?
 *
 * This is the ConvergenceRecord loop applied to a life decision: hypothesis (the choice
 * + rationale) → confidence → outcome → grade. Pure logic here (validation, grading,
 * calibration/Brier); JSONL persistence is the thin I/O layer.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const CATEGORIES = ["career", "money", "relationship", "health", "home", "other"];
const OUTCOMES = ["good", "mixed", "bad"];

function clamp01(x) { const n = Number(x); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; }

// Validate + normalize the content fields of a new decision (no id/timestamps — those
// are stamped by the store). Throws on a missing title/confidence.
function normalizeDecision(input = {}) {
  const title = String(input.title || "").trim();
  if (!title) throw new Error("title is required");
  const confidence = clamp01(input.confidence);
  if (confidence == null) throw new Error("confidence (0..1) is required");
  const category = CATEGORIES.includes(input.category) ? input.category : "other";
  return {
    title: title.slice(0, 280),
    rationale: String(input.rationale || "").slice(0, 2000),
    expectedOutcome: String(input.expectedOutcome || "").slice(0, 1000),
    category,
    confidence,
    decideBy: input.decideBy ? String(input.decideBy).slice(0, 40) : null,
    status: "open",
  };
}

// good=1, mixed=0.5, bad=0 — the realized "was this a good call" score.
function outcomeScore(outcome) {
  if (outcome === "good") return 1;
  if (outcome === "mixed") return 0.5;
  if (outcome === "bad") return 0;
  return null;
}

// Grade a resolved decision: how well did the stated confidence match reality?
function gradeDecision(decision) {
  const score = outcomeScore(decision.outcome);
  if (score == null || typeof decision.confidence !== "number") return null;
  const error = decision.confidence - score;           // + = overconfident, - = underconfident
  const absErr = Math.abs(error);
  let verdict = "well-calibrated";
  if (error > 0.34) verdict = "overconfident";
  else if (error < -0.34) verdict = "underconfident";
  return { score, error, absError: absErr, verdict };
}

// Calibration over the resolved decisions: overall good-call rate, Brier score (mean
// squared confidence-vs-outcome error; lower is better), a confidence/outcome bucket
// table, and a plain-language self-knowledge summary.
function calibration(decisions) {
  const resolved = (decisions || []).filter(
    (d) => d && d.status === "resolved" && outcomeScore(d.outcome) != null && typeof d.confidence === "number");
  const n = resolved.length;
  if (n === 0) {
    return { n: 0, goodCallRate: null, brier: null, buckets: [], tendency: null,
      summary: "No resolved decisions yet. Log a few and mark how they turned out to see your calibration.", status: "insufficient_data" };
  }
  const scores = resolved.map((d) => outcomeScore(d.outcome));
  const goodCallRate = scores.reduce((a, b) => a + b, 0) / n;
  const brier = resolved.reduce((a, d) => a + Math.pow(d.confidence - outcomeScore(d.outcome), 2), 0) / n;
  const signedErr = resolved.reduce((a, d) => a + (d.confidence - outcomeScore(d.outcome)), 0) / n;

  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inB = resolved.filter((d) => d.confidence >= lo && d.confidence < hi);
    if (!inB.length) continue;
    buckets.push({
      range: `${Math.round(lo * 100)}–${Math.round((i === edges.length - 2 ? 1 : hi) * 100)}%`,
      count: inB.length,
      predicted: inB.reduce((a, d) => a + d.confidence, 0) / inB.length,
      actual: inB.reduce((a, d) => a + outcomeScore(d.outcome), 0) / inB.length,
    });
  }
  const tendency = signedErr > 0.1 ? "overconfident" : (signedErr < -0.1 ? "underconfident" : "well-calibrated");
  const summary = tendency === "well-calibrated"
    ? `Your gut is well-calibrated: across ${n} resolved decisions, your confidence tracked how things actually turned out (Brier ${brier.toFixed(2)}).`
    : `You tend to be ${tendency}: your stated confidence runs ${Math.abs(Math.round(signedErr * 100))} points ${signedErr > 0 ? "above" : "below"} how decisions actually turned out (Brier ${brier.toFixed(2)}, ${n} resolved).`;
  return { n, goodCallRate, brier, signedError: signedErr, buckets, tendency, summary, status: "ok" };
}

// ── thin JSONL persistence ──────────────────────────────────────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "decisions", "decisions.jsonl"); }

function readDecisions(root) {
  try {
    return fs.readFileSync(_file(root), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function _writeAll(root, decisions) {
  const f = _file(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, decisions.map((d) => JSON.stringify(d)).join("\n") + (decisions.length ? "\n" : ""));
}

function createDecision(root, input) {
  const decision = {
    id: `dec:${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...normalizeDecision(input),
  };
  const all = readDecisions(root);
  all.push(decision);
  _writeAll(root, all);
  return decision;
}

function resolveDecision(root, id, outcome, notes) {
  if (!OUTCOMES.includes(outcome)) throw new Error("outcome must be good | mixed | bad");
  const all = readDecisions(root);
  const d = all.find((x) => x.id === id);
  if (!d) return null;
  d.status = "resolved";
  d.outcome = outcome;
  d.outcomeNotes = String(notes || "").slice(0, 1000);
  d.resolvedAt = new Date().toISOString();
  d.grade = gradeDecision(d);
  _writeAll(root, all);
  return d;
}

module.exports = {
  CATEGORIES, OUTCOMES,
  normalizeDecision, outcomeScore, gradeDecision, calibration,
  readDecisions, createDecision, resolveDecision,
};
