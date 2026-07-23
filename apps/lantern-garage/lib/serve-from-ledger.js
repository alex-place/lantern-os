"use strict";
// #2859 — serve-from-ledger: the "deterministic-from-outside" answer path.
//
// M1 invariant (operator directive 2026-07-22): an answer is a function of
// (question, verified knowledge) — never of the sampling path. When a question maps to a
// CONVERGED ConvergenceRecord (reality actually confirmed it — verified with a checkable
// artifact, at high confidence), return that record's result VERBATIM + provenance instead of
// regenerating. Regeneration is where variance leaks; re-asking must not be re-rolling.
//
// This generalizes the deterministic convergence-router (120 pinned routes) from routing to
// ANSWERS. It is a READER over the single canonical ledger (data/convergence/records.jsonl) —
// not a new store (Convergence-Core single-store rule). Best-effort: a miss or any error falls
// through to normal generation, and this never throws.

const { RECORDS_PATH } = require("./convergence-records");
const { readJsonlCached } = require("./jsonl-cache");
const { relevanceScore } = require("./csf-memory");

const MIN_CONFIDENCE = 0.8; // only converged records qualify
const MIN_SCORE = 0.55; // the question must strongly match the record's hypothesis

/**
 * A record is servable iff reality actually confirmed it AND it carries a usable answer.
 * Mirrors the convergence-records.js write-gate: verified=true is only legitimate with a
 * checkable artifact in verified_by (pr:/commit:/test:/exec:). An unverified or artifact-less
 * record is a hypothesis, not an answer — it is never served.
 */
function isConverged(r, minConfidence = MIN_CONFIDENCE) {
  return (
    !!r &&
    r.verified === true &&
    Array.isArray(r.verified_by) &&
    r.verified_by.length > 0 &&
    r.result != null &&
    String(r.result).trim() !== "" &&
    Number(r.confidence) >= minConfidence
  );
}

function answerText(result) {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Look up a deterministic ledger answer for a question. Returns the single best converged
 * record whose hypothesis matches, or null (→ caller regenerates normally).
 *
 * Deterministic: for a fixed (question, ledger) it always returns the SAME record — stable
 * tie-break by score, then confidence, then oldest timestamp, then id. No RNG, no sampling.
 *
 * @param {string} question
 * @param {object} [opts] minConfidence, minScore, path (test override)
 * @returns {{answer,score,deterministic,record_id,provenance}|null}
 */
function lookupLedgerAnswer(question, opts = {}) {
  try {
    const q = String(question == null ? "" : question).trim();
    if (!q) return null;
    const minConfidence = opts.minConfidence == null ? MIN_CONFIDENCE : Number(opts.minConfidence);
    const minScore = opts.minScore == null ? MIN_SCORE : Number(opts.minScore);
    const records = readJsonlCached(opts.path || RECORDS_PATH) || [];

    const scored = [];
    for (const r of records) {
      if (!isConverged(r, minConfidence)) continue;
      const score = relevanceScore(String(r.hypothesis || ""), q);
      if (score >= minScore) scored.push({ r, score });
    }
    if (!scored.length) return null;

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (Number(b.r.confidence) || 0) - (Number(a.r.confidence) || 0) ||
        String(a.r.timestamp || "").localeCompare(String(b.r.timestamp || "")) ||
        String(a.r.id || "").localeCompare(String(b.r.id || ""))
    );

    const best = scored[0].r;
    return {
      answer: answerText(best.result),
      score: Number(scored[0].score.toFixed(4)),
      deterministic: true,
      record_id: best.id || null,
      provenance: {
        record_id: best.id || null,
        confidence: Number(best.confidence) || 0,
        verified_by: best.verified_by.slice(),
        source: best.source == null ? null : String(best.source),
        timestamp: best.timestamp || null,
        reasoner: best.reasoner || null,
      },
    };
  } catch {
    return null; // a lookup must never break a reply — fall through to generation
  }
}

module.exports = { lookupLedgerAnswer, isConverged, MIN_CONFIDENCE, MIN_SCORE };
