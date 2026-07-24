"use strict";
// Domain-agnostic outcome grader: computes Brier score and ECE (Expected Calibration Error)
// for convergence records against ground-truth outcomes.
//
// Brier score: mean squared error between predicted probability and binary outcome.
// ECE: expected calibration error across confidence bins — measures if predicted confidence
// matches empirical win rate.
//
// Exported methods:
//   computeBrier(prediction, outcome) → { brier, calibrationMetric }
//   trackECE(predictions, outcomes) → { ece, calibrationMetric, binStats }
//
// Pure functions; no I/O or side effects.

// ── Brier score: mean squared error for a single prediction ──────────────────
// prediction: number in [0, 1] (confidence that outcome is true)
// outcome: boolean or 0/1 (ground truth)
// Returns { brier, calibrationMetric } where calibrationMetric is the raw error
function computeBrier(prediction, outcome) {
  if (typeof prediction !== "number" || prediction < 0 || prediction > 1) {
    return { brier: null, calibrationMetric: null, error: "prediction must be in [0, 1]" };
  }
  const outcomeValue = outcome ? 1 : 0;
  const error = prediction - outcomeValue;
  const brier = error * error;
  return { brier, calibrationMetric: Math.abs(error) };
}

// ── ECE: expected calibration error across confidence bins ──────────────────
// predictions: array of numbers in [0, 1]
// outcomes: array of booleans or 0/1, same length as predictions
// binCount: number of bins (default 10)
// Returns { ece, calibrationMetric, binStats } where:
//   ece: weighted average of |confidence - empirical_accuracy| per bin
//   calibrationMetric: same as ece (for consistency with computeBrier)
//   binStats: array of { bin, count, avgConfidence, empiricalAccuracy, error }
function trackECE(predictions, outcomes, binCount = 10) {
  if (!Array.isArray(predictions) || !Array.isArray(outcomes)) {
    return { ece: null, calibrationMetric: null, binStats: [], error: "predictions and outcomes must be arrays" };
  }
  if (predictions.length !== outcomes.length) {
    return { ece: null, calibrationMetric: null, binStats: [], error: "predictions and outcomes must have same length" };
  }
  if (predictions.length === 0) {
    return { ece: 0, calibrationMetric: 0, binStats: [] };
  }

  // Validate all predictions are in [0, 1]
  for (const p of predictions) {
    if (typeof p !== "number" || p < 0 || p > 1) {
      return { ece: null, calibrationMetric: null, binStats: [], error: "all predictions must be in [0, 1]" };
    }
  }

  // Initialize bins
  const bins = Array.from({ length: binCount }, (_, i) => ({
    bin: i,
    lowerBound: i / binCount,
    upperBound: (i + 1) / binCount,
    predictions: [],
    outcomes: [],
  }));

  // Assign predictions to bins
  for (let i = 0; i < predictions.length; i++) {
    const pred = predictions[i];
    const outcome = outcomes[i] ? 1 : 0;
    // Find bin: use upper bound for edge case (pred === 1.0)
    const binIndex = pred === 1.0 ? binCount - 1 : Math.floor(pred * binCount);
    bins[binIndex].predictions.push(pred);
    bins[binIndex].outcomes.push(outcome);
  }

  // Compute calibration error per bin
  let totalWeightedError = 0;
  let totalCount = 0;
  const binStats = [];

  for (const bin of bins) {
    if (bin.predictions.length === 0) continue;

    const avgConfidence = bin.predictions.reduce((a, b) => a + b, 0) / bin.predictions.length;
    const empiricalAccuracy = bin.outcomes.reduce((a, b) => a + b, 0) / bin.outcomes.length;
    const error = Math.abs(avgConfidence - empiricalAccuracy);

    binStats.push({
      bin: bin.bin,
      count: bin.predictions.length,
      avgConfidence,
      empiricalAccuracy,
      error,
    });

    totalWeightedError += error * bin.predictions.length;
    totalCount += bin.predictions.length;
  }

  const ece = totalCount > 0 ? totalWeightedError / totalCount : 0;
  return { ece, calibrationMetric: ece, binStats };
}

// ── Multi-class Brier score (for multi-outcome predictions) ────────────────
// predictions: array of probabilities for each class, must sum to ~1.0
// outcomeIndex: index of the true class (0-based)
// Returns { brier, calibrationMetric }
function computeMultiClassBrier(predictions, outcomeIndex) {
  if (!Array.isArray(predictions) || typeof outcomeIndex !== "number") {
    return { brier: null, calibrationMetric: null, error: "invalid input" };
  }
  if (outcomeIndex < 0 || outcomeIndex >= predictions.length) {
    return { brier: null, calibrationMetric: null, error: "outcomeIndex out of range" };
  }

  let brier = 0;
  for (let i = 0; i < predictions.length; i++) {
    const pred = predictions[i];
    const truth = i === outcomeIndex ? 1 : 0;
    const error = pred - truth;
    brier += error * error;
  }
  return { brier, calibrationMetric: brier };
}

module.exports = {
  computeBrier,
  trackECE,
  computeMultiClassBrier,
};
