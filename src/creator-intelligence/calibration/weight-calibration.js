// Creator Intelligence — calibrated re-weighting of the scoring priors (B4)
// Closes the loop: the V10 viral score's 8 component weights ship as heuristic
// PRIORS (research/viral_patterns.json, calibrated:false). Once the calibration
// set is large enough, this proposes new weights by blending the priors toward
// the components whose driving features actually correlate with real retention —
// with SHRINKAGE toward the priors (more data => more trust), never an overwrite.
//
// HONESTY: gated by calibration readiness. Below threshold (or with no mapped
// correlations) it returns the priors UNCHANGED with status insufficient_data —
// no calibrated claim is made before the operator's own data supports it. The
// result is a PROPOSAL; persisting it to viral_patterns.json is a deliberate,
// separately-gated step (not done here).
//
// See docs/creator-v10/editing-analysis-model-research.md (B4)

"use strict";

// Each score component → the measured feature signals it is computed from
// (see viral-score-v10.js). Correlation evidence for these features against the
// target outcome is what re-weights the component.
const COMPONENT_FEATURES = {
  hook: ["timeToFirstEventSec"],
  retention: ["cutsPerMin", "coverage"],
  emotion: ["audioActivityPerMin", "audioPeak"],
  surprise: ["multiSignalSpikesPerMin"],
  pacing: ["cutsPerMin", "gapCV"],
  rewatch: ["endPayoff", "lateSurprise"],
  visualClarity: ["excessMotion"],
  captionPotential: ["strongBeats", "wordsPerSec"],
};

const DEFAULT_TARGET = "avgPercentViewed"; // the platform's core retention signal
const SHRINKAGE_K = 200; // λ = n/(n+K), capped at 0.5

function round4(x) { return Number(Number(x).toFixed(4)); }

/**
 * @param {Object} priorWeights  e.g. viral_patterns.json .weights
 * @param {Object} correlations  ci.calibration.correlations() result
 * @param {Object} opts          { targetMetric, maxLambda=0.5 }
 * @returns insufficient_data (priors unchanged) OR
 *   { status:"ok", calibrated:true, weights, lambda, targetMetric, sampleSize, evidence }
 */
function calibrateWeights(priorWeights, correlations, opts = {}) {
  const priors = { ...priorWeights };
  const unchanged = (reason) => ({
    status: "insufficient_data", calibrated: false, reason, weights: priors,
  });

  if (!correlations || correlations.status !== "ok" || !correlations.calibrated) {
    return unchanged("calibration not ready (need >=100 usable outcomes)");
  }
  const target = opts.targetMetric || DEFAULT_TARGET;

  // |r| of each feature against the target outcome.
  const absR = {};
  for (const c of correlations.correlations || []) {
    if (c.metric === target && typeof c.r === "number") absR[c.feature] = Math.abs(c.r);
  }

  // Per-component evidence = mean |r| over its mapped features that have data.
  const evidence = {};
  const evidenced = [];
  for (const [comp, feats] of Object.entries(COMPONENT_FEATURES)) {
    if (priors[comp] === undefined) continue;
    const vals = feats.map((f) => absR[f]).filter((v) => typeof v === "number");
    if (vals.length) {
      evidence[comp] = round4(vals.reduce((s, v) => s + v, 0) / vals.length);
      evidenced.push(comp);
    }
  }
  if (evidenced.length === 0) return unchanged(`no feature correlations for target '${target}'`);

  // Redistribute ONLY the prior mass of the evidenced components, in proportion
  // to their evidence. Non-evidenced components keep their prior weight.
  const massE = evidenced.reduce((s, c) => s + priors[c], 0);
  const evSum = evidenced.reduce((s, c) => s + evidence[c], 0);
  const lambda = Math.min(opts.maxLambda ?? 0.5, correlations.sampleSize / (correlations.sampleSize + SHRINKAGE_K));

  const weights = { ...priors };
  if (evSum > 0) {
    for (const c of evidenced) {
      const evShare = massE * (evidence[c] / evSum);          // evidence-implied weight
      weights[c] = (1 - lambda) * priors[c] + lambda * evShare; // shrink toward prior
    }
  }
  // Renormalize to sum 1 (safety against rounding drift).
  const total = Object.values(weights).reduce((s, v) => s + v, 0) || 1;
  for (const k of Object.keys(weights)) weights[k] = round4(weights[k] / total);

  return {
    status: "ok",
    calibrated: true,
    targetMetric: target,
    sampleSize: correlations.sampleSize,
    lambda: round4(lambda),
    evidence,
    weights,
    note: "Proposed weights; persisting to viral_patterns.json is a separate gated step.",
  };
}

module.exports = { calibrateWeights, COMPONENT_FEATURES, DEFAULT_TARGET, SHRINKAGE_K };
