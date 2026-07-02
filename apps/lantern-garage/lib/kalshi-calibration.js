"use strict";

/**
 * Σ₀ forecast calibration — the Verify stage feeding back into Reason. The weather-edge
 * model (kalshi-weather-edge) emits a model win-probability per bucket; this module
 * grades those probabilities against SETTLED NWS outcomes and returns a calibrator that
 * corrects systematic over/under-confidence before the next Kelly sizing.
 *
 * This is the single gap the whole open-source weather-bot field shares (2026-07 review):
 * every credible bot emits an ensemble/model probability, none feed the realized Brier
 * back into a bias correction, so a persistently 3-point-hot forecast keeps mis-sizing
 * forever. We close that loop.
 *
 * Grounding: predictions + realized outcomes come from the paper ledger's resolved
 * weather positions (data/kalshi/paper-positions.jsonl, event:"close" WON/LOST rows that
 * carry the model pPredicted stamped at entry). External reality beats internal
 * consistency — the correction is measured, never assumed.
 *
 * DEGRADES TO IDENTITY under-sample. With < MIN_SAMPLES resolved predictions there is no
 * evidence to justify a shift, so calibrate(p) === p and the report says so. That honest
 * no-op is the correct output until the ledger has graded enough trades — exactly the
 * discipline the review found missing elsewhere.
 */

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const PAPER_FILE = path.join(KALSHI_DIR, "paper-positions.jsonl");

const MIN_SAMPLES = 20;            // resolved predictions before any correction applies
const MAX_LOGIT_SHIFT = 0.75;      // clamp the bias correction (≈ ±18 points at p=0.5)
const WEATHER_PREFIX = "KXHIGH";   // scope: only grade the weather series we actually run

function readLedger(file = PAPER_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Join open rows (which carry the stamped model prediction) with their close rows
 * (which carry the settled WON/LOST outcome) into graded prediction/outcome pairs.
 * A usable pair needs a numeric pPredicted on the open and a WON|LOST close.
 */
function gradedPairs(rows) {
  const openById = new Map();
  for (const r of rows) {
    if (r.event === "open") openById.set(r.id, r);
  }
  const pairs = [];
  for (const r of rows) {
    if (r.event !== "close") continue;
    const o = openById.get(r.id);
    if (!o) continue;
    const ticker = String(o.ticker || "");
    if (!ticker.startsWith(WEATHER_PREFIX)) continue;
    const p = Number(o.pPredicted);
    if (!Number.isFinite(p)) continue;
    const tag = String(r.exitTag || "").toUpperCase();
    let outcome;
    if (tag === "WON") outcome = 1;
    else if (tag === "LOST") outcome = 0;
    else continue;                          // unsettled / manual — not gradeable
    pairs.push({ p: Math.min(1, Math.max(0, p)), outcome, ticker, id: r.id });
  }
  return pairs;
}

function logit(p) { const c = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(c / (1 - c)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/**
 * getCalibrator — build the calibrator from the resolved weather ledger.
 * Returns { n, brier, bias, apply, calibrate, report }.
 *   brier    : mean (p − outcome)²  over graded pairs (lower is better; 0.25 = coin flip)
 *   bias     : mean(p) − mean(outcome). Positive = forecast runs HOT (over-predicts wins).
 *   calibrate(p): the corrected probability. Identity until n ≥ MIN_SAMPLES.
 */
function getCalibrator({ file = PAPER_FILE } = {}) {
  const pairs = gradedPairs(readLedger(file));
  const n = pairs.length;
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  const brier = n ? mean(pairs.map((x) => (x.p - x.outcome) ** 2)) : null;
  const bias = n ? mean(pairs.map((x) => x.p)) - mean(pairs.map((x) => x.outcome)) : 0;

  // Correction: a logit shift that removes the measured mean bias, clamped. This nudges
  // the whole curve without over-fitting a slope to a handful of resolved trades.
  const shift = n >= MIN_SAMPLES
    ? Math.max(-MAX_LOGIT_SHIFT, Math.min(MAX_LOGIT_SHIFT, -logit(0.5 + bias / 2) * Math.sign(bias || 1) * Math.abs(bias) * 2))
    : 0;
  const active = n >= MIN_SAMPLES && Math.abs(shift) > 1e-4;

  const calibrate = (p) => {
    const q = Number(p);
    if (!Number.isFinite(q)) return p;
    if (!active) return q;                    // identity under-sample — honest no-op
    return Math.min(0.999, Math.max(0.001, sigmoid(logit(q) + shift)));
  };

  const report = active
    ? `calibrated on n=${n} settled weather trades · Brier ${brier.toFixed(3)} · bias ${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(1)}pt (${bias > 0 ? "forecast runs hot" : "forecast runs cold"}) · logit shift ${shift.toFixed(3)}`
    : `identity (no-op): only n=${n} settled weather trades (need ${MIN_SAMPLES}) — no correction justified yet`;

  return { n, brier, bias, shift, active, calibrate, apply: calibrate, report, minSamples: MIN_SAMPLES };
}

// ── self-test ─────────────────────────────────────────────────────────────────
function selfTest() {
  const fails = [];

  // Under-sample → identity.
  const rowsFew = [
    { event: "open", id: "a", ticker: "KXHIGHNY-1", pPredicted: 0.8 },
    { event: "close", id: "a", exitTag: "LOST" },
  ];
  const calFew = buildFrom(rowsFew);
  if (calFew.active) fails.push("n=1 should be identity");
  if (Math.abs(calFew.calibrate(0.7) - 0.7) > 1e-9) fails.push("under-sample calibrate must be identity");

  // Persistently HOT forecast (predicts high, loses) over enough samples → bias>0, shift pulls DOWN.
  const rowsHot = [];
  for (let i = 0; i < 30; i++) {
    rowsHot.push({ event: "open", id: `h${i}`, ticker: "KXHIGHNY-x", pPredicted: 0.80 });
    rowsHot.push({ event: "close", id: `h${i}`, exitTag: i < 12 ? "WON" : "LOST" }); // 40% win vs 80% predicted
  }
  const calHot = buildFrom(rowsHot);
  if (!(calHot.active && calHot.bias > 0.2)) fails.push(`hot bias not detected: bias=${calHot.bias?.toFixed(3)}`);
  if (!(calHot.calibrate(0.80) < 0.80)) fails.push(`hot forecast should be pulled down: ${calHot.calibrate(0.80).toFixed(3)}`);
  if (!(calHot.brier > 0.25)) fails.push(`hot Brier should be poor (>0.25): ${calHot.brier?.toFixed(3)}`);

  // Non-weather tickers must be ignored.
  const rowsMixed = [
    { event: "open", id: "c", ticker: "KXBTC-1", pPredicted: 0.9 },
    { event: "close", id: "c", exitTag: "LOST" },
  ];
  if (buildFrom(rowsMixed).n !== 0) fails.push("non-weather ticker must not be graded");

  return { ok: fails.length === 0, fails };
}

// test helper: build a calibrator from in-memory rows without touching disk
function buildFrom(rows) {
  const pairs = gradedPairs(rows);
  const n = pairs.length;
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  const brier = n ? mean(pairs.map((x) => (x.p - x.outcome) ** 2)) : null;
  const bias = n ? mean(pairs.map((x) => x.p)) - mean(pairs.map((x) => x.outcome)) : 0;
  const shift = n >= MIN_SAMPLES
    ? Math.max(-MAX_LOGIT_SHIFT, Math.min(MAX_LOGIT_SHIFT, -logit(0.5 + bias / 2) * Math.sign(bias || 1) * Math.abs(bias) * 2))
    : 0;
  const active = n >= MIN_SAMPLES && Math.abs(shift) > 1e-4;
  const calibrate = (p) => (!active ? p : Math.min(0.999, Math.max(0.001, sigmoid(logit(p) + shift))));
  return { n, brier, bias, shift, active, calibrate };
}

module.exports = { getCalibrator, gradedPairs, selfTest, MIN_SAMPLES, WEATHER_PREFIX };

if (require.main === module) {
  const r = selfTest();
  process.stdout.write(`Σ₀ kalshi-calibration self-test: ${r.ok ? "PASS" : "FAIL"}\n`);
  if (!r.ok) { for (const f of r.fails) process.stdout.write("  - " + f + "\n"); process.exit(1); }
  const live = getCalibrator();
  process.stdout.write(`live: ${live.report}\n`);
}
