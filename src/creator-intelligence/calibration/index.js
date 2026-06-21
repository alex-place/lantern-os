// Creator Intelligence — calibration namespace
// Convenience surface that ties the analytics importer, outcome store, and
// calibration engine together, plus disk loaders for the common end-to-end path:
//   parse CSV -> propose links -> ingest -> readiness/correlations.
//
// See docs/creator-v10/learning-pipeline-research.md

"use strict";

const fs = require("fs");
const path = require("path");

const { parseAnalyticsCsv } = require("./youtube-analytics-import");
const { parseRetentionCsv } = require("./retention-curve-import");
const retention = require("./retention-analysis");
const dropoff = require("./dropoff-model");
const weightCalibration = require("./weight-calibration");
const store = require("./outcome-store");
const engine = require("./calibration-engine");

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Load local creator entries (id + title + measured features) from disk.
 * Best-effort: skips entries without a readable metadata.json.
 * @returns {Array<{id, title, features}>}
 */
function loadEntries() {
  const entriesDir = path.join(repoRoot(), "data", "creator", "entries");
  if (!fs.existsSync(entriesDir)) return [];
  const out = [];
  for (const dir of fs.readdirSync(entriesDir)) {
    const metaPath = path.join(entriesDir, dir, "metadata.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      out.push({
        id: entry.id || dir,
        title: entry.title || entry.name || dir,
        features: engine.loadFeaturesFromEntry(entry),
      });
    } catch { /* skip unreadable entry */ }
  }
  return out;
}

/**
 * Import directly from CSV text. Proposes links against local entries and
 * ingests only the confirmed (auto/manual) ones. Returns a report including the
 * links that still NEED human confirmation (never written automatically).
 *
 * @param {string} text  raw CSV contents (YouTube Studio "Table data" export)
 * @param {Object} opts
 *   - manualLinks?: [{videoRef, entryId}]  operator-confirmed joins
 *   - outcomeSource?: provenance string
 *   - dryRun?: when true, only propose links — write nothing (preview mode)
 */
function importCsvText(text, opts = {}) {
  const parsed = parseAnalyticsCsv(text);
  const entries = loadEntries();

  if (parsed.recognizedMetrics.length === 0) {
    return {
      status: "error",
      reason: "no recognizable analytics columns found (expected a YouTube Studio table export)",
      parsed: { rows: parsed.rows.length, recognizedMetrics: [], skipped: parsed.skipped.length },
    };
  }

  const proposals = engine.proposeLinks(parsed.rows, entries, opts);

  // Fold any operator-supplied manual links in as confirmed.
  if (Array.isArray(opts.manualLinks)) {
    const manualByRef = new Map(opts.manualLinks.map((l) => [l.videoRef, l]));
    for (const p of proposals) {
      const m = manualByRef.get(p.videoRef);
      if (m && m.entryId) { p.entryId = m.entryId; p.method = "manual"; p.status = "auto"; p.confidence = 1; }
    }
  }

  const featuresByEntryId = {};
  for (const e of entries) featuresByEntryId[e.id] = e.features;

  // Optional A4→B2 enrichment: { entryId: { curveText, segments, durationSec } }.
  // Parse each retention CSV to points here; ingest does the (pure) attribution.
  const retentionByEntryId = {};
  if (opts.retentionByEntryId && typeof opts.retentionByEntryId === "object") {
    for (const [entryId, ret] of Object.entries(opts.retentionByEntryId)) {
      if (!ret) continue;
      const points = ret.points || (ret.curveText ? parseRetentionCsv(ret.curveText).points : []);
      if (points && points.length >= 2) {
        retentionByEntryId[entryId] = { points, segments: ret.segments, durationSec: ret.durationSec };
      }
    }
  }

  const ingested = opts.dryRun
    ? { written: 0, usable: 0, skipped: [], dryRun: true }
    : engine.ingest({
        analyticsRows: parsed.rows,
        links: proposals,
        featuresByEntryId,
        retentionByEntryId,
        outcomeSource: opts.outcomeSource || "youtube_studio_csv",
      });

  return {
    status: "ok",
    parsed: { rows: parsed.rows.length, recognizedMetrics: parsed.recognizedMetrics, skipped: parsed.skipped.length },
    ingested,
    autoLinked: proposals.filter((p) => p.status === "auto").length,
    needsConfirmation: proposals.filter((p) => p.status === "needs_confirmation"),
    unmatched: proposals.filter((p) => p.status === "unmatched"),
    readiness: engine.readiness(),
  };
}

/**
 * Full import from a CSV file path (delegates to importCsvText).
 * @param {string} csvPath
 * @param {Object} opts  see importCsvText
 */
function importCsvFile(csvPath, opts = {}) {
  if (!fs.existsSync(csvPath)) {
    return { status: "error", reason: `file not found: ${csvPath}` };
  }
  return importCsvText(fs.readFileSync(csvPath, "utf8"), opts);
}

// B4 callable: propose calibrated scoring weights from the live correlation set.
// Returns insufficient_data (priors unchanged) until calibration readiness is ok.
const PRIOR_WEIGHTS = require("../research/viral_patterns.json").weights;
const { saveCalibratedWeights, loadCalibratedWeights } = require("./weights-artifact");

function proposeCalibratedWeights(opts = {}) {
  const corr = engine.correlations(opts);
  return weightCalibration.calibrateWeights(PRIOR_WEIGHTS, corr, opts);
}

// #909: the missing PRODUCER. Propose calibrated weights from real labeled outcomes
// and PERSIST the artifact so viral-score-v10's loadCalibratedWeights() flips
// calibrated:true. saveCalibratedWeights is honesty-gated (writes only when
// status==='ok' && calibrated===true), so this is a safe no-op until enough real
// outcome rows exist — no fabricated calibration.
function commitCalibratedWeights(opts = {}) {
  const result = proposeCalibratedWeights(opts);
  const written = saveCalibratedWeights(result);
  return {
    written,
    status: result.status,
    calibrated: !!result.calibrated,
    reason: result.reason || null,
    weights: result.weights || null,
  };
}

module.exports = {
  parseAnalyticsCsv,
  loadEntries,
  importCsvFile,
  importCsvText,
  proposeLinks: engine.proposeLinks,
  ingest: engine.ingest,
  readiness: engine.readiness,
  correlations: engine.correlations,
  calibratedRecommendations: engine.calibratedRecommendations,
  loadFeaturesFromEntry: engine.loadFeaturesFromEntry,
  // A4 — audience-retention curve: parse, analyze, attribute drop-offs to edits.
  parseRetentionCsv,
  retentionCurveMetrics: retention.curveMetrics,
  retentionOutcomeMetrics: retention.retentionOutcomeMetrics,
  attributeCliffToSegments: retention.attributeCliffToSegments,
  enrichFromCurve: retention.enrichFromCurve,
  // B2 — drop-off-aware cutting (gated; no-op until calibrated).
  buildDropoffProfile: dropoff.buildDropoffProfile,
  dropoffPenalty: dropoff.dropoffPenalty,
  // B4 — propose calibrated scoring weights (gated; priors unchanged until ready).
  calibrateWeights: weightCalibration.calibrateWeights,
  proposeCalibratedWeights,
  commitCalibratedWeights,         // #909: propose + persist (honesty-gated)
  saveCalibratedWeights,
  loadCalibratedWeights,
  priorWeights: () => ({ ...PRIOR_WEIGHTS }),
  COMPONENT_FEATURES: weightCalibration.COMPONENT_FEATURES,
  count: store.count,
  usableRows: store.usableRows,
  thresholds: {
    MIN_FOR_CORRELATION: engine.MIN_FOR_CORRELATION,
    MIN_FOR_CALIBRATION: engine.MIN_FOR_CALIBRATION,
    AUTO_LINK_CONFIDENCE: engine.AUTO_LINK_CONFIDENCE,
  },
};
