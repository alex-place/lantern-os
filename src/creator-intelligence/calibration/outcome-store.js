// Creator Intelligence — labeled-outcome store
// Append-only JSONL store for OUTCOME rows: a measured edit (the operator's own
// rendered/uploaded clip) joined to its REAL performance metrics imported from
// first-party analytics. These rows are the calibration set — the thing that
// turns "structural estimate" scores into calibrated ones.
//
// HONESTY CONTRACT (enforced in validateOutcomeRow, never bypassed):
//   * outcome must be a non-empty object of finite numbers (a real metric).
//   * features come from the user's own analyzed clip; provenance is recorded.
//   * a row whose link to a local entry is not confirmed is NEVER written here.
//
// Storage: data/creator-intelligence/outcomes/outcomes.jsonl  (git-ignored)
//          data/creator-intelligence/outcomes/links.json      (confirmed links)
// The base dir is overridable via LANTERN_CI_DATA_DIR for isolated testing.

"use strict";

const fs = require("fs");
const path = require("path");

function baseDataDir() {
  if (process.env.LANTERN_CI_DATA_DIR) return process.env.LANTERN_CI_DATA_DIR;
  // src/creator-intelligence/calibration -> repo root is three levels up.
  return path.join(path.resolve(__dirname, "..", "..", ".."), "data", "creator-intelligence");
}

function outcomesDir() { return path.join(baseDataDir(), "outcomes"); }
function outcomesFile() { return path.join(outcomesDir(), "outcomes.jsonl"); }
function linksFile() { return path.join(outcomesDir(), "links.json"); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const LINK_METHODS = ["manual", "exact_title", "fuzzy_title", "video_id"];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Strict validator. A row that fails is rejected at append time so the
 * calibration set can never silently accumulate fabricated/empty labels.
 * @returns {{valid:boolean, errors:string[]}}
 */
function validateOutcomeRow(row) {
  const errors = [];
  if (!row || typeof row !== "object") return { valid: false, errors: ["row is not an object"] };
  if (typeof row.id !== "string" || row.id === "") errors.push("id required");
  if (typeof row.entryId !== "string" || row.entryId === "") errors.push("entryId required (confirmed link)");
  if (typeof row.collectedAt !== "string" || row.collectedAt === "") errors.push("collectedAt (ISO-8601) required");
  if (!LINK_METHODS.includes(row.linkMethod)) errors.push(`linkMethod must be one of ${LINK_METHODS.join("|")}`);
  if (!isFiniteNumber(row.linkConfidence) || row.linkConfidence < 0 || row.linkConfidence > 1) {
    errors.push("linkConfidence must be a number in [0,1]");
  }
  if (typeof row.outcomeSource !== "string" || row.outcomeSource === "") errors.push("outcomeSource required (provenance)");

  // The whole point: a real outcome with at least one finite metric.
  if (!row.outcome || typeof row.outcome !== "object") {
    errors.push("outcome must be an object");
  } else {
    const metricCount = Object.values(row.outcome).filter(isFiniteNumber).length;
    if (metricCount === 0) errors.push("outcome must contain at least one finite metric (no empty labels)");
  }

  // features may be absent (then the row is stored but unusable for calibration),
  // but if present it must be an object of finite numbers only.
  if (row.features !== undefined && row.features !== null) {
    if (typeof row.features !== "object") errors.push("features must be an object when present");
    else {
      for (const [k, v] of Object.entries(row.features)) {
        if (!isFiniteNumber(v)) errors.push(`features.${k} must be a finite number`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function appendOutcome(row) {
  const { valid, errors } = validateOutcomeRow(row);
  if (!valid) throw new Error(`invalid outcome row: ${errors.join("; ")}`);
  ensureDir(outcomesDir());
  fs.appendFileSync(outcomesFile(), JSON.stringify(row) + "\n", "utf8");
  return true;
}

/** Read every outcome row (skips malformed lines rather than counting them). */
function readAll() {
  const file = outcomesFile();
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return rows;
}

function count() {
  return readAll().length;
}

/** Rows usable for calibration = have both a real outcome and measured features. */
function usableRows() {
  return readAll().filter(
    (r) => r.features && Object.keys(r.features).length > 0 &&
           r.outcome && Object.values(r.outcome).some(isFiniteNumber)
  );
}

// --- Confirmed link map (videoRef -> entryId), for idempotent re-imports ---

function readLinks() {
  const file = linksFile();
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveLink(videoRef, entryId) {
  if (!videoRef || !entryId) return false;
  ensureDir(outcomesDir());
  const links = readLinks();
  links[videoRef] = entryId;
  fs.writeFileSync(linksFile(), JSON.stringify(links, null, 2), "utf8");
  return true;
}

module.exports = {
  validateOutcomeRow, appendOutcome, readAll, count, usableRows,
  readLinks, saveLink,
  // paths (resolved lazily so LANTERN_CI_DATA_DIR overrides apply per-call)
  outcomesDir, outcomesFile, linksFile,
  LINK_METHODS,
};
