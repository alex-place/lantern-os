// Research status — surfaces the open-video learning flywheel for the Creator
// Dashboard. Reads only what the research loop actually produced (editing_priors,
// weight_deltas, the feature corpus, the last nightly report). No fabricated
// numbers: if the corpus is empty it says so.

"use strict";

const fs = require("fs");
const path = require("path");

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}
function countLines(p) {
  try { return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length; } catch (_) { return 0; }
}

function getResearchStatus(repoRoot) {
  const priors = readJsonSafe(path.join(repoRoot, "editing_priors.json")) || {};
  const deltas = readJsonSafe(path.join(repoRoot, "research", "weight_deltas.json"));
  const corpusCount = countLines(path.join(repoRoot, "research", "open_video", "features", "features.jsonl"));

  // Effective weights via the same adapter the scorer uses (so the panel shows
  // exactly what the editor will apply right now).
  let effective = null, base = null, priorInformed = false;
  try {
    base = require(path.join(repoRoot, "src", "creator-intelligence", "research", "viral_patterns.json"));
    const { effectivePriors, MIN_SAMPLES } = require(path.join(repoRoot, "src", "creator-intelligence", "scoring", "editing-priors-adapter.js"));
    const eff = effectivePriors(base);
    effective = eff.weights;
    priorInformed = !!eff._priorInformed;
    var minSamples = MIN_SAMPLES;
  } catch (_) { /* scoring tree absent — degrade gracefully */ }
  const MIN = typeof minSamples === "number" ? minSamples : 25;

  // Last nightly: prefer a structured log, fall back to the report's mtime.
  let lastNightly = null;
  const reportPath = path.join(repoRoot, "research", "nightly_report.md");
  try {
    if (fs.existsSync(reportPath)) {
      const m = fs.readFileSync(reportPath, "utf8").match(/videos_analyzed:\s*(\d+)/i);
      lastNightly = { at: fs.statSync(reportPath).mtime.toISOString(), analyzed: m ? Number(m[1]) : null };
    }
  } catch (_) {}

  const samples = Number(priors.samples) || corpusCount || 0;
  return {
    ok: true,
    corpus: { samples, updatedAt: priors.updatedAt || null, featureRows: corpusCount },
    adaptation: {
      priorInformed,
      minSamples: MIN,
      readiness: Math.min(1, MIN > 0 ? samples / MIN : 0), // 0..1 toward the adaptation threshold
      samplesNeeded: Math.max(0, MIN + 1 - samples),
      status: priorInformed ? "adapting" : (samples > 0 ? "collecting" : "idle"),
    },
    priors: {
      opening_hook_strength: priors.opening_hook_strength ?? null,
      avg_cut_rate: priors.avg_cut_rate ?? null,
      motion_target: priors.motion_target ?? null,
      facecam: priors.facecam ?? null,
      facecam_distribution: priors.facecam_distribution || {},
    },
    weights: {
      effective,                 // the 8 V10 component weights the editor will apply now
      base: base ? base.weights : null,
      source: priorInformed ? "viral_patterns.json + editing_priors.json" : "viral_patterns.json (baseline)",
    },
    weightDeltas: deltas ? deltas.weights : null,
    hookPriors: readJsonSafe(path.join(repoRoot, "research", "hook_priors.json")),
    highlightPriors: readJsonSafe(path.join(repoRoot, "research", "highlight_priors.json")),
    facecamPriors: readJsonSafe(path.join(repoRoot, "research", "facecam_priors.json")),
    lastNightly,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getResearchStatus };
