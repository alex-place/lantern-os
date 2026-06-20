// Creator Intelligence — public API surface
// Single entry point for the V10 subsystem. Population-dependent calls
// short-circuit to insufficient_data when the subsystem flag is off or the
// dataset is empty. Per-video and export-validation calls work regardless.
//
// See docs/creator-v10/creator-intelligence-architecture.md

"use strict";

const flags = require("./dataset/feature-flags");
const datasetStore = require("./dataset/dataset-store");
const scoreEngine = require("./scoring/score-engine");
const { validateExport, DEFAULTS: EXPORT_DEFAULTS } = require("./scoring/export-validator");
const reverseEngineer = require("./analysis/reverse-engineer");
const learningStore = require("./training/learning-store");
const calibration = require("./calibration");
const recommend = require("./recommendations/recommend");
const { scoreVideoV10 } = require("./scoring/score-v10");
const { generateVariantsV10 } = require("./scoring/variant-engine-v10");

function subsystemEnabled(env) {
  return flags.isEnabled("creatorIntelligence", env);
}

function disabledResult(reason = "subsystem_disabled") {
  return { status: "insufficient_data", reason, have: 0, need: null };
}

module.exports = {
  // Flags
  flags: (env) => flags.resolveFlags(env),
  isEnabled: flags.isEnabled,

  // Dataset (counts always honest, even when subsystem disabled)
  dataset: {
    counts: () => datasetStore.counts(),
    gamingCountsByGame: () => datasetStore.gamingCountsByGame(),
    appendGeneral: (row) => datasetStore.appendGeneral(row),
    appendGaming: (row) => datasetStore.appendGaming(row),
    refreshManifest: () => datasetStore.refreshManifest(),
  },

  // Analysis (gated by researchReport + dataset sufficiency)
  analysis: {
    reverseEngineer: (opts, env) =>
      flags.isEnabled("researchReport", env)
        ? reverseEngineer.reverseEngineer(opts)
        : disabledResult("researchReport_flag_off"),
  },

  // Scoring (gated by subsystem + dataset sufficiency)
  scoring: {
    viralScore: (features, opts, env) =>
      subsystemEnabled(env) ? scoreEngine.viralScore(features, opts) : disabledResult(),
    retentionScore: (features, opts, env) =>
      subsystemEnabled(env) ? scoreEngine.retentionScore(features, opts) : disabledResult(),
    gameSufficiency: (game) => scoreEngine.gameSufficiency(game),
  },

  // V10 per-clip structural scoring (always real — computed from the user's own
  // analyzed video; never population claims). Returns viral/gaming/retention/grade.
  scoreVideoV10: (analysis, opts) => scoreVideoV10(analysis, opts),

  // V10 multi-variant generator (5 ranked strategy variants, real cut-lists).
  generateVariantsV10: (analysis, opts) => generateVariantsV10(analysis, opts),

  // Continuous learning (first-party data — always allowed)
  training: learningStore,

  // Analytics calibration (first-party data). Ingest/readiness/correlations are
  // honest by construction; gated by the `calibration` flag so it never runs
  // unprompted. Reads short-circuit to insufficient_data when the flag is off.
  calibration: {
    enabled: (env) => flags.isEnabled("calibration", env),
    importCsvFile: (csvPath, opts, env) =>
      flags.isEnabled("calibration", env)
        ? calibration.importCsvFile(csvPath, opts)
        : disabledResult("calibration_flag_off"),
    importCsvText: (text, opts, env) =>
      flags.isEnabled("calibration", env)
        ? calibration.importCsvText(text, opts)
        : disabledResult("calibration_flag_off"),
    proposeLinks: (rows, entries, opts) => calibration.proposeLinks(rows, entries, opts),
    parseAnalyticsCsv: (text) => calibration.parseAnalyticsCsv(text),
    readiness: (env) =>
      flags.isEnabled("calibration", env) ? calibration.readiness() : disabledResult("calibration_flag_off"),
    correlations: (opts, env) =>
      flags.isEnabled("calibration", env) ? calibration.correlations(opts) : disabledResult("calibration_flag_off"),
    recommendations: (opts, env) =>
      flags.isEnabled("calibration", env) ? calibration.calibratedRecommendations(opts) : disabledResult("calibration_flag_off"),
    weights: (opts, env) =>
      flags.isEnabled("calibration", env) ? calibration.proposeCalibratedWeights(opts) : disabledResult("calibration_flag_off"),
    count: () => calibration.count(),
    thresholds: () => calibration.thresholds,
    loadEntries: () => calibration.loadEntries(),
  },

  // Recommendations (per-video always real; population path honest)
  recommendations: {
    forVideo: (analysis) => recommend.forVideo(analysis),
  },

  // Export validation (real ffprobe; flag on by default)
  validateExport: (outputPath, options, env) => {
    if (!flags.isEnabled("exportValidator", env)) {
      return Promise.resolve({
        ok: true,
        checks: [{ name: "validator", ok: true, actual: "skipped (flag off)" }],
        blockedReasons: [],
        skipped: true,
        probedAt: new Date().toISOString(),
      });
    }
    return validateExport(outputPath, options);
  },
  EXPORT_DEFAULTS,
};
