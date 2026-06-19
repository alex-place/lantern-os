// Editing-Priors Adapter — makes the Σ₀ V10 scorer adapt to open-video research.
//
// It blends the LEARNED open-license editing priors (editing_priors.json,
// produced by scripts/open-video-research.js) into the baseline V10 component
// weights (research/viral_patterns.json) — but ONLY once samples > 25, so we
// never adapt on thin data.
//
// HONESTY: the adjustments are bounded, documented DIRECTIONAL nudges with
// explicit neutral midpoints — the SAME honesty class as viral_patterns.json
// ("DESIGN PARAMETERS, not statistics learned from a proprietary dataset"). They
// are NOT a fitted model. Only the component WEIGHTS are nudged; signal
// THRESHOLDS stay at baseline because the research extractor's units differ from
// the scorer's (recenter those only against real first-party outcomes — see
// docs/EDITOR_LEARNING_AUDIT.md). Every shift is inspectable via weightDeltas().

"use strict";

const fs = require("fs");
const path = require("path");

const MIN_SAMPLES = 25; // never adapt below this
const ROOT = path.resolve(__dirname, "..", "..", "..");
const PRIOR_PATHS = [
  path.join(ROOT, "editing_priors.json"),
  path.join(ROOT, "data", "research", "editing_priors.json"),
];

function num(x) { return Number.isFinite(x) ? x : null; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round3(x) { return Number(Number(x).toFixed(3)); }

function loadLearnedPriors() {
  for (const p of PRIOR_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j && Number.isFinite(j.samples)) return j;
      }
    } catch (_) { /* ignore unreadable/partial priors */ }
  }
  return null;
}

// Per-component emphasis multipliers (1 = unchanged). Neutral midpoints are
// labeled; deviations are bounded so a single prior can't dominate.
function emphasis(p) {
  const e = { hook: 1, retention: 1, emotion: 1, surprise: 1, pacing: 1, rewatch: 1, visualClarity: 1, captionPotential: 1 };
  const hook = num(p.opening_hook_strength); // normalized 0..1, neutral 0.5
  const motion = num(p.motion_target);       // normalized busy-ness 0..1, neutral 0.4 (assumed)
  const apk = num(p.avg_audio_peaks);        // peaks/clip, neutral 2 (assumed)

  // Corpus opens hard -> the editor should value fast hooks more (and vice versa).
  if (hook != null) e.hook *= 1 + clamp((hook - 0.5) * 0.6, -0.3, 0.3);
  // Busy/spiky corpus -> value surprise + pacing a little more.
  if (motion != null) { const k = clamp((motion - 0.4) * 0.5, -0.15, 0.15); e.surprise *= 1 + k; e.pacing *= 1 + k; }
  // Loud corpus -> value emotion a little more.
  if (apk != null) { const k = clamp((apk - 2) * 0.03, -0.15, 0.15); e.emotion *= 1 + k; }
  return e;
}

// Blend baseline weights toward the corpus emphasis, then renormalize to sum 1
// (so the overall score range is preserved; only the balance shifts).
function blendWeights(baseWeights, p) {
  const e = emphasis(p);
  const raw = {};
  let total = 0;
  for (const k of Object.keys(baseWeights)) { raw[k] = baseWeights[k] * (e[k] || 1); total += raw[k]; }
  const out = {};
  for (const k of Object.keys(raw)) out[k] = total > 0 ? raw[k] / total : baseWeights[k];
  return out;
}

// The effective scoring priors the scorer should use: baseline, with weights
// blended toward the learned corpus when samples > 25. Thresholds untouched.
function effectivePriors(basePriors) {
  const learned = loadLearnedPriors();
  if (!learned || !(learned.samples > MIN_SAMPLES)) {
    return { ...basePriors, _priorInformed: false, _samples: learned ? learned.samples : 0 };
  }
  return { ...basePriors, weights: blendWeights(basePriors.weights, learned), _priorInformed: true, _samples: learned.samples };
}

// Σ₀ self-calibration record: baseline vs prior-informed weights.
function weightDeltas(basePriors) {
  const learned = loadLearnedPriors();
  const informed = effectivePriors(basePriors);
  const weights = {};
  for (const k of Object.keys(basePriors.weights)) {
    const before = basePriors.weights[k];
    const after = informed.weights[k];
    weights[k] = { before: round3(before), after: round3(after), delta: round3(after - before) };
  }
  return {
    _comment: "Σ₀ self-calibration: baseline viral_patterns.json weights vs open-video prior-informed weights. Regenerate: `node scripts/open-video-research.js --calibrate`.",
    samples: learned ? learned.samples : 0,
    minSamples: MIN_SAMPLES,
    priorInformed: informed._priorInformed,
    generatedAt: new Date().toISOString(),
    weights,
  };
}

module.exports = { effectivePriors, weightDeltas, loadLearnedPriors, emphasis, MIN_SAMPLES };
