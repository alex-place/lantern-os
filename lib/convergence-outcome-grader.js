"use strict";
// convergence-outcome-grader.js — domain-agnostic Brier calibration for convergence records.
//
// #1011: convergence records carry a frozen heuristic confidence (0.7 online / 0.3 offline)
// that is never graded against outcomes. An ungraded confidence number is worse than none.
//
// This module is the generalisation of kalshi-convergence-outcomes.js' pass/fail grading
// into a proper scoring-rule grader. For any record where outcome ground-truth is known:
//   Brier contribution = (confidence - outcome)^2  where outcome ∈ {0, 1}
//
// USAGE by domain-specific callers (e.g. kalshi-convergence-outcomes.js):
//   const { gradeRecord, calibrationSummary } = require("./convergence-outcome-grader");
//   const graded = gradeRecord(record, { passed: true });      // outcome known
//   await appendJsonlQueued(OUTCOMES_PATH, graded);
//   const cal = calibrationSummary(gradedLines);               // across all graded records
//
// Pure functions throughout — no I/O. Caller owns file operations.

const N_ECE_BINS = 10;

// ── Pure: compute a single Brier contribution ────────────────────────────────
// confidence: number 0–1 (from record.confidence)
// outcome: boolean or 0/1 (did the record's claim prove correct?)
// Returns brier_score ∈ [0, 1] (0 = perfect, 1 = worst possible).
function brierScore(confidence, outcome) {
  const f = Math.max(0, Math.min(1, Number(confidence) || 0));
  const o = outcome ? 1 : 0;
  return (f - o) * (f - o);
}

// ── Pure: produce a graded outcome line from a convergence record + resolution ─
// record:      { id, confidence, reasoner, hypothesis, ... }
// resolution:  { passed: bool, notes?: string }
// Returns an outcome object suitable for appending to outcomes.jsonl. Adds
// brier_score so the frozen heuristic is replaced by a calibration signal.
function gradeRecord(record, resolution) {
  const { passed, notes = "" } = resolution;
  const confidence = Number(record.confidence) || 0;
  return {
    record_id: record.id,
    passed: !!passed,
    confidence,
    brier_score: brierScore(confidence, passed),
    reasoner: record.reasoner || null,
    graded_at: new Date().toISOString(),
    notes,
  };
}

// ── Pure: aggregate calibration across a set of graded outcome lines ──────────
// gradedLines: array of outcome objects (from gradeRecord or loaded from JSONL)
// Returns { n, mean_brier, ece, skill_score, calibration_bins }
//   mean_brier:   average Brier score (lower = better, 0.25 = random baseline)
//   ece:          expected calibration error across N_ECE_BINS probability bins
//   skill_score:  1 - mean_brier / 0.25 (positive = beats random, negative = worse)
//   calibration_bins: array of { low, high, n, mean_confidence, mean_outcome, error }
function calibrationSummary(gradedLines) {
  const lines = (gradedLines || []).filter(
    (l) => l && typeof l.brier_score === "number" && typeof l.confidence === "number"
  );
  const n = lines.length;
  if (n === 0) {
    return { n: 0, mean_brier: null, ece: null, skill_score: null, calibration_bins: [] };
  }

  const totalBrier = lines.reduce((s, l) => s + l.brier_score, 0);
  const meanBrier = totalBrier / n;

  // ECE: group predictions into N_ECE_BINS equal-width confidence bins
  const bins = Array.from({ length: N_ECE_BINS }, (_, i) => ({
    low: i / N_ECE_BINS,
    high: (i + 1) / N_ECE_BINS,
    n: 0,
    sumConf: 0,
    sumOut: 0,
  }));
  for (const l of lines) {
    const binIdx = Math.min(Math.floor(l.confidence * N_ECE_BINS), N_ECE_BINS - 1);
    bins[binIdx].n++;
    bins[binIdx].sumConf += l.confidence;
    bins[binIdx].sumOut += l.passed ? 1 : 0;
  }
  let eceTotalErr = 0;
  const calBins = bins.map((b) => {
    if (b.n === 0) return { low: b.low, high: b.high, n: 0, mean_confidence: null, mean_outcome: null, error: null };
    const meanConf = b.sumConf / b.n;
    const meanOut = b.sumOut / b.n;
    const err = Math.abs(meanConf - meanOut);
    eceTotalErr += (b.n / n) * err;
    return { low: b.low, high: b.high, n: b.n, mean_confidence: meanConf, mean_outcome: meanOut, error: err };
  });

  const randomBaseline = 0.25; // Brier score for a constant 0.5 forecast
  const skillScore = 1 - meanBrier / randomBaseline;

  return {
    n,
    mean_brier: meanBrier,
    ece: eceTotalErr,
    skill_score: skillScore,
    calibration_bins: calBins,
  };
}

// ── Pure: load and filter graded lines from a JSONL string (no FS access) ────
function parseGradedLines(text) {
  const lines = [];
  for (const raw of String(text || "").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.brier_score === "number") lines.push(o);
    } catch { /* skip corrupt */ }
  }
  return lines;
}

module.exports = {
  brierScore,
  gradeRecord,
  calibrationSummary,
  parseGradedLines,
  N_ECE_BINS,
};
