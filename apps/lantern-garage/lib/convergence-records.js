"use strict";
// wq-005 — Convergence Record emitter (Reason → Act → Verify cycle).
//
// dream-chat reasoning emits a ConvergenceRecord whose shape mirrors
// src/convergence/objects.py::ConvergenceRecord EXACTLY, so the Python
// Convergence Core can load these records. The cross-language schema is locked
// by tests/test_convergence_records.py. Emission is best-effort and never throws
// — a failed record must never break a chat reply.

const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

// Resolve to repo root (same base file-queue's readers use), so writes land
// where readJsonl("data/convergence/records.jsonl") would read them.
const RECORDS_REL = "data/convergence/records.jsonl";
const RECORDS_PATH = path.resolve(__dirname, "..", "..", "..", RECORDS_REL);

function _id() {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build + persist one ConvergenceRecord. Returns the record, or null on failure.
 * @param {object} o
 * @param {string} o.hypothesis      what the reasoning claims / is about
 * @param {string[]} [o.evidence_ids] supporting Memory ids
 * @param {*} [o.result]             the decision/action/reply produced
 * @param {number} [o.confidence]    0..1 (clamped)
 * @param {string} [o.reasoner]      which agent/tool reasoned
 * @param {boolean} [o.verified]     tested yet? (false at emit time)
 * @param {string|null} [o.verification_notes]
 * @param {string|null} [o.source]          External Reality Rule: where did this come from?
 * @param {string[]} [o.applied_evidence] verification-evidence hashes already folded
 *        into confidence (#764 G9). Empty at emit time; the Python Verify stage fills
 *        it so replaying the same test/NIS reading can't ratchet confidence to 1.0.
 * @param {string[]} [o.grounding_signals] ExternalGroundingSensor ids (empty at emit time)
 * @param {number|null} [o.allowed_max_confidence] confidence ceiling when grounding is weak
 */
async function emitConvergenceRecord({
  hypothesis,
  evidence_ids = [],
  result = null,
  confidence = 0.5,
  reasoner = "unknown",
  verified = false,
  verification_notes = null,
  source = null,
  applied_evidence = [],
  grounding_signals = [],
  allowed_max_confidence = null,
} = {}) {
  try {
    const record = {
      id: _id(),
      hypothesis: String(hypothesis == null ? "" : hypothesis),
      evidence_ids: Array.isArray(evidence_ids) ? evidence_ids.map(String) : [],
      result: result === undefined ? null : result,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      reasoner: String(reasoner || "unknown"),
      timestamp: new Date().toISOString(),
      verified: Boolean(verified),
      verification_notes: verification_notes == null ? null : String(verification_notes),
      source: source == null ? null : String(source),
      applied_evidence: Array.isArray(applied_evidence) ? applied_evidence.map(String) : [],
      // Σ₀ grounding fields — mirror the Python ConvergenceRecord dataclass
      // (src/convergence/objects.py). Empty/null at emit; filled during Verify.
      grounding_signals: Array.isArray(grounding_signals) ? grounding_signals.map(String) : [],
      allowed_max_confidence: allowed_max_confidence == null ? null : Number(allowed_max_confidence),
    };
    await appendJsonlQueued(RECORDS_PATH, record, { rotate: true }); // #872
    return record;
  } catch (err) {
    console.error("[convergence-records] emit failed (non-fatal):", err && err.message);
    return null;
  }
}

module.exports = { emitConvergenceRecord, RECORDS_PATH, RECORDS_REL };
