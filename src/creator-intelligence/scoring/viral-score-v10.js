// Viral Score V10 — multi-factor structural scorer
// Replaces "score = motion + audio" with an 8-component weighted model.
//
// HONESTY: this is a per-clip STRUCTURAL score. Every component is computed
// from real signals measured by the ffmpeg highlight analysis of the user's
// own upload (HighlightTimeline). Weights/thresholds are research-informed
// heuristic priors (research/viral_patterns.json, calibrated:false), NOT
// statistics learned from a dataset we possess. The score does not predict
// real-world views — population-calibrated scoring lives in score-engine.js
// and returns insufficient_data until a dataset exists.
//
// Spec: docs/creator-v10 / "V10 SCORING ENGINE REDESIGN" Phase 2.

"use strict";

const PRIORS = require("../research/viral_patterns.json");
const { effectivePriors } = require("./editing-priors-adapter");
const { loadCalibratedWeights } = require("../calibration/weights-artifact");

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function round3(x) { return Number(Number(x).toFixed(3)); }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

/**
 * Normalize an analysis input into the signals the scorer needs, all derived
 * from real measured highlights.
 */
function deriveSignals(analysis) {
  const highlights = Array.isArray(analysis.highlights) ? analysis.highlights : [];
  const durationSec = Math.max(
    1e-6,
    Number(analysis.duration) ||
      (highlights.length ? Math.max(...highlights.map((h) => h.end || 0)) : 0)
  );
  const durationMin = durationSec / 60;

  const tagged = (tag) => highlights.filter((h) => Array.isArray(h.tags) && h.tags.includes(tag));
  const multiTag = highlights.filter((h) => Array.isArray(h.tags) && h.tags.length >= 2);

  const timeToFirstEventSec = highlights.length
    ? Math.min(...highlights.map((h) => h.start))
    : null;

  // A1: prefer the MEASURED shot-boundary cut rate (real scene cuts) when the
  // analysis carries it; fall back to the highlight-count proxy otherwise. The
  // flag makes the provenance auditable downstream (and in calibration).
  const shot = analysis.metadata && analysis.metadata.shotBoundaries;
  const cutsPerMinMeasured = !!(shot && shot.measured && typeof shot.cutsPerMin === "number");
  const cutsPerMin = cutsPerMinMeasured
    ? shot.cutsPerMin
    : (durationMin > 0 ? highlights.length / durationMin : 0);
  const avgShotLengthSec = cutsPerMinMeasured && typeof shot.avgShotLengthSec === "number"
    ? shot.avgShotLengthSec
    : null;
  const coverage = clamp01(
    highlights.reduce((s, h) => s + (h.duration || Math.max(0, (h.end || 0) - (h.start || 0))), 0) / durationSec
  );

  // Inter-onset gap regularity (pacing rhythm).
  const onsets = highlights.map((h) => h.start).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1]);
  const gapMean = mean(gaps);
  const gapStd = gaps.length
    ? Math.sqrt(mean(gaps.map((g) => (g - gapMean) ** 2)))
    : 0;
  const gapCV = gapMean > 0 ? gapStd / gapMean : 1; // lower = more rhythmic

  const audioHl = tagged("audio");
  const audioActivityPerMin = durationMin > 0 ? audioHl.length / durationMin : 0;
  const audioPeak = audioHl.length ? Math.max(...audioHl.map((h) => h.score || 0)) : 0;

  const multiSignalSpikesPerMin = durationMin > 0 ? multiTag.length / durationMin : 0;

  // Ending payoff: strongest highlight in the last 20% of the clip.
  const lateThreshold = 0.8 * durationSec;
  const lateHl = highlights.filter((h) => h.start >= lateThreshold);
  const endPayoff = lateHl.length ? Math.max(...lateHl.map((h) => h.score || 0)) : 0;
  const lateSurprise = durationMin > 0
    ? lateHl.filter((h) => (h.tags || []).length >= 2).length / Math.max(0.2, durationMin * 0.2)
    : 0;

  const excessMotion = highlights.length
    ? tagged("motion").filter((h) => (h.score || 0) > 0.8).length / highlights.length
    : 0;

  const strongBeats = highlights.filter((h) => (h.score || 0) >= 0.5).length;

  // A3: measured speech features when the analysis carries a transcript-derived
  // block (timeline.metadata.speech). Numeric ones feed calibration; categorical
  // ones (hookStyle, ctaPosition) are exposed as honest diagnostics. Absent =>
  // nulls/flags, never inferred from audio energy.
  const sp = analysis.metadata && analysis.metadata.speech;
  const speechMeasured = !!(sp && sp.measured);
  const wordsPerSec = speechMeasured && typeof sp.wordsPerSec === "number" ? sp.wordsPerSec : null;
  const speechCoverage = speechMeasured && typeof sp.speechCoverage === "number" ? sp.speechCoverage : null;
  const deadAirMaxSec = speechMeasured && typeof sp.deadAirMaxSec === "number" ? sp.deadAirMaxSec : null;
  const hookStyle = speechMeasured ? sp.hookStyle : null;
  const ctaPresent = speechMeasured ? sp.ctaPresent : null;
  const ctaPosition = speechMeasured ? sp.ctaPosition : null;

  return {
    durationSec, durationMin, highlightsCount: highlights.length,
    hasAudioSignal: audioHl.length > 0,
    timeToFirstEventSec, cutsPerMin, cutsPerMinMeasured, avgShotLengthSec, coverage,
    gapCV, audioActivityPerMin, audioPeak, multiSignalSpikesPerMin,
    endPayoff, lateSurprise, excessMotion, strongBeats,
    speechMeasured, wordsPerSec, speechCoverage, deadAirMaxSec,
    hookStyle, ctaPresent, ctaPosition,
  };
}

// --- Component scorers (each returns { score, confidence, inputs }) ---

function scoreHook(s) {
  const cfg = PRIORS.signals.hookSpeed;
  if (s.timeToFirstEventSec === null) {
    return { score: 0, confidence: 0.2, inputs: { timeToFirstEventSec: null } };
  }
  const t = s.timeToFirstEventSec;
  const hard = 6.0; // score reaches 0 here
  let score;
  if (t <= cfg.targetMaxSec) score = 1;
  else score = clamp01((hard - t) / (hard - cfg.targetMaxSec));
  return { score: round3(score), confidence: 0.85, inputs: { timeToFirstEventSec: round3(t), targetMaxSec: cfg.targetMaxSec } };
}

function scoreRetention(s) {
  const [lo] = PRIORS.signals.sceneDensity.goodBandPerMin;
  const densityScore = clamp01(s.cutsPerMin / lo); // saturates at the band floor
  const score = 0.6 * densityScore + 0.4 * s.coverage;
  const confidence = s.highlightsCount >= 3 ? 0.8 : 0.4;
  return { score: round3(score), confidence, inputs: { cutsPerMin: round3(s.cutsPerMin), coverage: round3(s.coverage) } };
}

function scoreEmotion(s) {
  // Proxy from audio energy: activity rate + peak loudness of audio events.
  const activity = clamp01(s.audioActivityPerMin / 10);
  const score = clamp01(0.5 * activity + 0.5 * s.audioPeak);
  const confidence = s.hasAudioSignal ? 0.7 : 0.25; // honest: no audio events => low confidence
  return { score: round3(score), confidence, inputs: { audioActivityPerMin: round3(s.audioActivityPerMin), audioPeak: round3(s.audioPeak) } };
}

function scoreSurprise(s) {
  const score = clamp01(s.multiSignalSpikesPerMin / 6); // ~6 multi-signal spikes/min saturates
  const confidence = s.highlightsCount >= 3 ? 0.8 : 0.4;
  return { score: round3(score), confidence, inputs: { multiSignalSpikesPerMin: round3(s.multiSignalSpikesPerMin) } };
}

function scorePacing(s) {
  const [lo] = PRIORS.signals.sceneDensity.goodBandPerMin;
  const density = clamp01(s.cutsPerMin / lo);
  const rhythm = clamp01(1 - Math.min(1, s.gapCV)); // lower gap variance => steadier rhythm
  const score = 0.6 * density + 0.4 * rhythm;
  const confidence = s.highlightsCount >= 4 ? 0.75 : 0.4;
  return { score: round3(score), confidence, inputs: { cutsPerMin: round3(s.cutsPerMin), gapCV: round3(s.gapCV) } };
}

function scoreRewatch(s) {
  const score = clamp01(0.7 * s.endPayoff + 0.3 * clamp01(s.lateSurprise));
  const confidence = s.highlightsCount >= 2 ? 0.65 : 0.3;
  return { score: round3(score), confidence, inputs: { endPayoff: round3(s.endPayoff), lateSurprise: round3(s.lateSurprise) } };
}

function scoreVisualClarity(s) {
  // Proxy: pathological constant high motion reduces readability. Weak signal
  // (no blur/sharpness metric yet) => modest confidence by design.
  const score = clamp01(1 - 0.5 * s.excessMotion);
  return { score: round3(score), confidence: 0.4, inputs: { excessMotionFraction: round3(s.excessMotion) } };
}

function scoreCaptionPotential(s) {
  const beatScore = clamp01(s.strongBeats / 6);
  const audioScore = clamp01(s.audioActivityPerMin / 10);
  const score = clamp01(0.6 * beatScore + 0.4 * audioScore);
  const confidence = s.highlightsCount >= 2 ? 0.6 : 0.3;
  return { score: round3(score), confidence, inputs: { strongBeats: s.strongBeats } };
}

/**
 * Compute the V10 viral score for an analyzed clip.
 * @param {Object} analysis  HighlightTimeline.toJSON()-shaped: { duration, highlights[] }
 * @returns {{viralScore, confidence, componentScores, basis, calibrated, weightsSource, computedAt}}
 */
function viralScoreV10(analysis = {}) {
  const s = deriveSignals(analysis);
  const components = {
    hook: scoreHook(s),
    retention: scoreRetention(s),
    emotion: scoreEmotion(s),
    surprise: scoreSurprise(s),
    pacing: scorePacing(s),
    rewatch: scoreRewatch(s),
    visualClarity: scoreVisualClarity(s),
    captionPotential: scoreCaptionPotential(s),
  };

  // Weights adapt to open-video research once >25 samples exist (else baseline).
  // Signal THRESHOLDS stay at baseline (units differ) — see the adapter.
  // Calibration bridge (B4): if the operator's labeled outcomes have produced a
  // calibrated weight set (weight-calibration -> weights-artifact), score with it and
  // report calibrated:true. Absent that, fall back to the heuristic / open-video priors
  // (calibrated:false). insufficient_data is never persisted, so this never fabricates.
  const priorEff = effectivePriors(PRIORS);
  const cal = loadCalibratedWeights();
  const eff = cal
    ? { weights: { ...priorEff.weights, ...cal.weights }, _priorInformed: priorEff._priorInformed, _samples: priorEff._samples }
    : priorEff;
  const w = eff.weights;
  let viralScore = 0;
  let confWeighted = 0;
  let confWeightTotal = 0;
  const componentScores = {};
  for (const [name, c] of Object.entries(components)) {
    const weight = w[name] ?? 0;
    viralScore += weight * c.score;
    confWeighted += weight * c.confidence;
    confWeightTotal += weight;
    componentScores[name] = { score: c.score, weight, confidence: c.confidence, inputs: c.inputs };
  }

  // No usable structure at all => be honest about near-zero confidence.
  const baseConfidence = confWeightTotal > 0 ? confWeighted / confWeightTotal : 0;
  const dataPenalty = s.highlightsCount === 0 ? 0.15 : 1.0;

  return {
    viralScore: round3(clamp01(viralScore)),
    confidence: round3(clamp01(baseConfidence * dataPenalty)),
    componentScores,
    basis: cal ? "calibrated" : "structural_heuristic",
    calibrated: !!cal,
    priorInformed: eff._priorInformed,
    priorSamples: eff._samples,
    weightsSource: cal
      ? `calibrated: operator outcomes (n=${cal.sampleSize ?? "?"}, target=${cal.targetMetric ?? "?"})`
      : eff._priorInformed
        ? "research/viral_patterns.json + editing_priors.json (open-video, >25 samples)"
        : "research/viral_patterns.json",
    signals: s,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { viralScoreV10, deriveSignals, clamp01 };
