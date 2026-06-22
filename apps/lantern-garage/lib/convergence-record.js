"use strict";
// Convergence record: immutable log entry for a single reasoning step.
// Replaces frozen 0.7/0.3 confidence heuristic with outcome-graded confidence
// (Brier score and ECE calibration).
//
// Schema:
//   id: unique identifier (UUID)
//   timestamp: ISO 8601 creation time
//   reasoner: source reasoner name (e.g., "kalshi-suggest", "dream-chat")
//   hypothesis: the claim or prediction
//   confidence: predicted probability [0, 1] (outcome-graded if ground truth available)
//   evidence_ids: array of supporting evidence references
//   source: source of the prediction (e.g., "online", "offline", "market")
//   result: optional human-readable outcome summary
//   brier: Brier score (null if unresolved)
//   ece: Expected Calibration Error (null if unresolved)
//   calibrationMetric: unified calibration metric (null if unresolved)
//   verified: boolean; true if graded against ground truth
//   verification_notes: optional notes from grading

const { v4: uuidv4 } = require("uuid");
const { computeBrier, trackECE } = require("./outcome-grader");

// ── Create a new convergence record ────────────────────────────────────────
function createConvergenceRecord({
  reasoner,
  hypothesis,
  confidence = null,
  evidence_ids = [],
  source = "unknown",
  result = null,
} = {}) {
  // Validate confidence if provided
  if (confidence !== null && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
    throw new Error("confidence must be null or a number in [0, 1]");
  }

  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    reasoner,
    hypothesis,
    confidence,
    evidence_ids: Array.isArray(evidence_ids) ? evidence_ids : [],
    source,
    result,
    brier: null,
    ece: null,
    calibrationMetric: null,
    verified: false,
    verification_notes: null,
  };
}

// ── Grade a record against a ground-truth outcome ────────────────────────────
// outcome: boolean or 0/1 (ground truth)
// Returns the updated record with brier, ece, calibrationMetric, verified, verification_notes
function gradeRecord(record, outcome) {
  if (!record || typeof record !== "object") {
    throw new Error("record must be an object");
  }
  if (record.confidence === null || record.confidence === undefined) {
    return {
      ...record,
      verified: false,
      verification_notes: "no confidence to grade",
    };
  }

  const { brier, calibrationMetric } = computeBrier(record.confidence, outcome);
  const outcomeValue = outcome ? 1 : 0;

  return {
    ...record,
    brier,
    calibrationMetric,
    verified: true,
    verification_notes: `graded against outcome ${outcomeValue}; brier=${brier.toFixed(4)}`,
  };
}

// ── Batch grade multiple records and compute ECE ───────────────────────────
// records: array of convergence records (all must have confidence)
// outcomes: array of booleans/0-1 (same length as records)
// Returns { gradedRecords, ece, binStats }
function gradeRecordBatch(records, outcomes) {
  if (!Array.isArray(records) || !Array.isArray(outcomes)) {
    throw new Error("records and outcomes must be arrays");
  }
  if (records.length !== outcomes.length) {
    throw new Error("records and outcomes must have same length");
  }

  // Grade each record individually
  const gradedRecords = records.map((record, i) => gradeRecord(record, outcomes[i]));

  // Compute ECE across the batch
  const confidences = records.map((r) => r.confidence).filter((c) => c !== null);
  const validOutcomes = outcomes.slice(0, confidences.length);

  const { ece, binStats } = trackECE(confidences, validOutcomes);

  return { gradedRecords, ece, binStats };
}

// ── Assign outcome-graded confidence to a record ───────────────────────────
// If ground truth is resolvable (outcome is not null), grade the record and
// update its confidence field. Otherwise, return the record unchanged.
function assignOutcomeGradedConfidence(record, outcome) {
  if (outcome === null || outcome === undefined) {
    return record; // no ground truth; return unchanged
  }

  const graded = gradeRecord(record, outcome);
  // Optionally: update confidence based on grading result
  // For now, keep the original confidence and add calibration fields
  return graded;
}

// ── Serialize record to JSON ──────────────────────────────────────────────
function recordToJSON(record) {
  return JSON.stringify(record);
}

// ── Deserialize record from JSON ──────────────────────────────────────────
function recordFromJSON(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`failed to parse record JSON: ${e.message}`);
  }
}

// ── Validate record schema ────────────────────────────────────────────────
function validateRecord(record) {
  const required = ["id", "timestamp", "reasoner", "hypothesis"];
  for (const field of required) {
    if (!record || !(field in record)) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  if (record.confidence !== null && (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1)) {
    return { valid: false, error: "confidence must be null or in [0, 1]" };
  }
  return { valid: true };
}

module.exports = {
  createConvergenceRecord,
  gradeRecord,
  gradeRecordBatch,
  assignOutcomeGradedConfidence,
  recordToJSON,
  recordFromJSON,
  validateRecord,
};
