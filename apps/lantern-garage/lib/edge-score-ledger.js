'use strict';

/**
 * edge-score-ledger.js — prediction ledger + calibration for the equity "edge score" (#3259).
 *
 * Every issued edge score is a PREDICTION, and every prediction gets graded. This is the
 * launch gate for any user-facing score and the substance behind the public calibration page:
 * a score you cannot show is calibrated is a score you cannot ship.
 *
 * Three pieces, mirroring the loop's Verify → Converge stages (this is a convergence-record
 * ledger — hypothesis=score, evidence=realized bars, result=outcome — NOT a new parallel store):
 *
 *   1. Ledger (append-only JSONL). One row per issued score:
 *        { date, symbol, score, components, horizonDays, benchmark, settled, outcome, ... }
 *      The row is IMMUTABLE once written. `score` is the model's forecast probability (0..1)
 *      that `symbol` beats `benchmark` over `horizonDays`. `components` is the explainable
 *      sub-score breakdown. No look-ahead: a score only ever references data available at
 *      `date` — that invariant is the producer's job (#3258); this module never rewrites a score.
 *
 *   2. Settlement (pure, replayable). Given the ledger + archived bars, grade each MATURED row
 *      (issue date + horizon has passed) by comparing the symbol's realized forward return to
 *      the benchmark's over the SAME window. Because settlement is a pure function of
 *      (immutable predictions, archived bars), it is fully replayable — re-running it from the
 *      append-only ledger reproduces the identical grades. Rows that aren't matured yet, or whose
 *      bars are missing, stay open and are graded on a later pass.
 *
 *   3. Calibration summary. Brier score, Brier skill score vs the base rate (climatology),
 *      per-decile (equal-count) hit rates with n, and an equal-width reliability table.
 *
 * PURE core: makeRow / settle / computeCalibration operate on plain data with no I/O, so the
 * whole thing is unit-testable from a synthetic ledger. Thin fs wrappers (appendPrediction /
 * readLedger / runSettlement) default to data/trading/ and use the shared append queue.
 *
 * Deliberately self-contained: the equity edge score is a different domain and schema from the
 * Kalshi weather calibrator (lib/kalshi-calibration.js), and adds equal-count deciles +
 * settlement-from-bars that that module does not have. The one-line Brier is not worth coupling
 * two trading domains through a shared import.
 */

const fs = require('fs');
const path = require('path');
const { appendJsonlQueued } = require('./file-queue');

// Append-only prediction ledger + the derived (overwritten) calibration artifact.
const LEDGER_PATH = path.resolve(__dirname, '../../data/trading/edge-predictions.jsonl');
const CALIBRATION_PATH = path.resolve(__dirname, '../../data/trading/edge-calibration.json');

// ── small helpers ────────────────────────────────────────────────────────────────────────────
const isNum = (x) => Number.isFinite(Number(x));
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x)));
const round = (x, d = 6) => { const f = 10 ** d; return Math.round(Number(x) * f) / f; };
const todayUTC = () => new Date().toISOString().slice(0, 10);

/** Add N calendar days to a YYYY-MM-DD string; return YYYY-MM-DD (UTC, DST-safe). */
function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

// ── row schema ─────────────────────────────────────────────────────────────────────────────────
/**
 * Normalize + validate a raw prediction into a ledger row. Throws on missing symbol / non-numeric
 * score so a malformed prediction never silently pollutes the calibration.
 * @param {object} pred { symbol, score(0..1), date?, components?, horizonDays?, benchmark? }
 */
function makeRow(pred) {
  if (!pred || !pred.symbol) throw new Error('edge-ledger: prediction requires a symbol');
  if (!isNum(pred.score)) throw new Error('edge-ledger: prediction requires a numeric score (0..1)');
  return {
    date: String(pred.date || todayUTC()).slice(0, 10),      // issue date (as-of); score references only data <= this
    symbol: String(pred.symbol).toUpperCase(),
    score: clamp01(pred.score),                              // forecast P(symbol beats benchmark) at issue time
    components: pred.components && typeof pred.components === 'object' ? pred.components : {},
    horizonDays: Math.max(1, Math.round(Number(pred.horizonDays) || 5)),
    benchmark: String(pred.benchmark || 'SPY').toUpperCase(),
    settled: false,
    outcome: null,                                           // 1 = beat benchmark over horizon, 0 = did not
    settledAt: null,
    symbolReturn: null,
    benchmarkReturn: null,
  };
}

// ── I/O (thin) ──────────────────────────────────────────────────────────────────────────────────
function _ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Append one prediction to the append-only ledger. Returns the normalized row. */
async function appendPrediction(pred, { file = LEDGER_PATH } = {}) {
  const row = makeRow(pred);
  _ensureDir(file);
  await appendJsonlQueued(file, row);
  return row;
}

/** Read the ledger into an array of rows (tolerant of blank / partial trailing lines). */
function readLedger({ file = LEDGER_PATH } = {}) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (_e) { /* skip a torn line */ }
  }
  return rows;
}

// ── settlement (pure) ───────────────────────────────────────────────────────────────────────────
/** A row is matured (gradeable) when its issue date + horizon is on or before `asOf`. */
function isMatured(row, asOf) {
  return addDays(row.date, row.horizonDays) <= String(asOf).slice(0, 10);
}

/**
 * Grade every unsettled, matured row via `resolve(row) -> { outcome, symbolReturn?, benchmarkReturn? }`.
 * Returns a NEW array (never mutates the input) plus counts. A row stays open (ungraded) when it is
 * not yet matured, or when `resolve` returns null/NaN (e.g. bars not archived yet) — so the same
 * append-only ledger can be re-settled later and converge to the same grades.
 *
 * @param {object[]} rows      ledger rows
 * @param {(row)=>({outcome:number,symbolReturn?:number,benchmarkReturn?:number}|null)} resolve
 * @param {object} [opts] { asOf?: 'YYYY-MM-DD' }
 */
function settle(rows, resolve, { asOf = todayUTC() } = {}) {
  let settledCount = 0;
  let openCount = 0;
  const out = (rows || []).map((r) => {
    if (r.settled) return r;
    if (!isMatured(r, asOf)) { openCount++; return r; }
    let res = null;
    try { res = resolve(r); } catch (_e) { res = null; }
    if (!res || !isNum(res.outcome)) { openCount++; return r; }   // can't grade yet — leave open
    settledCount++;
    return {
      ...r,
      settled: true,
      outcome: res.outcome ? 1 : 0,
      settledAt: String(asOf).slice(0, 10),
      symbolReturn: isNum(res.symbolReturn) ? round(res.symbolReturn) : null,
      benchmarkReturn: isNum(res.benchmarkReturn) ? round(res.benchmarkReturn) : null,
    };
  });
  return { rows: out, settledCount, openCount };
}

/**
 * Build a resolver over archived daily bars. `barsBySymbol` maps SYMBOL -> ascending array of
 * bars, each { date | time, close }. Outcome = 1 when the symbol's forward return from the
 * issue-date close to the horizon-date close exceeds the benchmark's over the identical window.
 * Reads ONLY bars inside [issueDate, issueDate+horizon]; returns null (leave open) when either
 * leg lacks bars to bracket the window.
 */
function barsResolver(barsBySymbol) {
  const dateOf = (b) => b.date || (b.time ? String(b.time).slice(0, 10) : '');
  const closeOnOrAfter = (bars, dateStr) => {
    for (const b of bars) { const d = dateOf(b); if (d && d >= dateStr) return { d, close: Number(b.close) }; }
    return null;
  };
  const closeOnOrBefore = (bars, dateStr) => {
    let last = null;
    for (const b of bars) { const d = dateOf(b); if (!d) continue; if (d <= dateStr) last = { d, close: Number(b.close) }; else break; }
    return last;
  };
  return (row) => {
    const sb = barsBySymbol[row.symbol];
    const bb = barsBySymbol[row.benchmark];
    if (!Array.isArray(sb) || !Array.isArray(bb)) return null;
    const end = addDays(row.date, row.horizonDays);
    const s0 = closeOnOrAfter(sb, row.date);
    const s1 = closeOnOrBefore(sb, end);
    const b0 = closeOnOrAfter(bb, row.date);
    const b1 = closeOnOrBefore(bb, end);
    if (!s0 || !s1 || !b0 || !b1) return null;
    if (!(s0.close > 0) || !(b0.close > 0) || s1.d <= s0.d) return null;   // need a real forward window
    const symbolReturn = s1.close / s0.close - 1;
    const benchmarkReturn = b1.close / b0.close - 1;
    // Grade from the raw comparison; report rounded returns so the resolver's numbers are clean.
    return { outcome: symbolReturn > benchmarkReturn ? 1 : 0, symbolReturn: round(symbolReturn), benchmarkReturn: round(benchmarkReturn) };
  };
}

// ── calibration (pure) ──────────────────────────────────────────────────────────────────────────
/** Brier score = mean (p − outcome)²  (lower is better; 0.25 = a coin flip). */
function brierScore(pairs) {
  if (!pairs.length) return null;
  return round(pairs.reduce((s, x) => s + (x.p - x.o) ** 2, 0) / pairs.length);
}

/**
 * Equal-COUNT deciles: sort by forecast, split into `k` near-equal buckets, report the realized
 * hit rate per bucket. This is the "does a higher score actually win more often" table — distinct
 * from the equal-width reliability curve below.
 */
function decileHitRates(pairs, k = 10) {
  const sorted = pairs.slice().sort((a, b) => a.p - b.p);
  const n = sorted.length;
  if (!n) return [];
  const out = [];
  for (let i = 0; i < k; i++) {
    const lo = Math.floor((i * n) / k);
    const hi = Math.floor(((i + 1) * n) / k);
    const slice = sorted.slice(lo, hi);
    if (!slice.length) continue;
    const hits = slice.reduce((s, x) => s + x.o, 0);
    out.push({
      decile: i + 1,
      n: slice.length,
      meanScore: round(slice.reduce((s, x) => s + x.p, 0) / slice.length, 4),
      hitRate: round(hits / slice.length, 4),
      scoreMin: round(slice[0].p, 4),
      scoreMax: round(slice[slice.length - 1].p, 4),
    });
  }
  return out;
}

/**
 * Equal-WIDTH reliability table: bin [0,1] into `nBins`; for each occupied bin report predicted
 * (mean forecast) vs observed (realized hit rate). `gap` > 0 means over-confident in that bin.
 */
function reliabilityTable(pairs, nBins = 10) {
  const bins = Array.from({ length: nBins }, (_, i) => ({ i, n: 0, sumP: 0, sumO: 0 }));
  for (const x of pairs) {
    let k = Math.floor(x.p * nBins);
    if (k >= nBins) k = nBins - 1;
    if (k < 0) k = 0;
    bins[k].n++; bins[k].sumP += x.p; bins[k].sumO += x.o;
  }
  return bins.filter((b) => b.n > 0).map((b) => ({
    bin: b.i + 1,
    range: [round(b.i / nBins, 4), round((b.i + 1) / nBins, 4)],
    n: b.n,
    predicted: round(b.sumP / b.n, 4),
    observed: round(b.sumO / b.n, 4),
    gap: round(b.sumP / b.n - b.sumO / b.n, 4),
  }));
}

/**
 * Full calibration summary over settled rows. Uses only rows with settled===true and a numeric
 * outcome. Returns { n, brier, brierSkillScore, baseRate, deciles, reliability, generatedAt }.
 *   brierSkillScore = 1 − Brier / (baseRate·(1−baseRate))  (vs a constant base-rate forecast;
 *   > 0 means the score beats climatology; null when the base rate is degenerate).
 */
function computeCalibration(rows, { nDeciles = 10, nBins = 10, now = null } = {}) {
  const pairs = (rows || [])
    .filter((r) => r && r.settled && isNum(r.outcome) && isNum(r.score))
    .map((r) => ({ p: clamp01(r.score), o: r.outcome ? 1 : 0 }));
  const n = pairs.length;
  const baseRate = n ? round(pairs.reduce((s, x) => s + x.o, 0) / n, 4) : null;
  const brier = brierScore(pairs);
  let brierSkillScore = null;
  if (n && baseRate != null && baseRate > 0 && baseRate < 1) {
    brierSkillScore = round(1 - brier / (baseRate * (1 - baseRate)), 4);
  }
  return {
    n,
    brier,
    brierSkillScore,
    baseRate,
    deciles: decileHitRates(pairs, nDeciles),
    reliability: reliabilityTable(pairs, nBins),
    generatedAt: now || new Date().toISOString(),
  };
}

// ── settlement job (I/O wrapper) ──────────────────────────────────────────────────────────────
/**
 * Read the ledger, settle matured rows against `barsBySymbol`, write the calibration artifact,
 * and return { summary, settledCount, openCount }. The predictions ledger stays append-only —
 * settlement is recomputed in memory each run (replayable). `barsBySymbol` is injected so this is
 * testable offline; a caller can source it from lib/market-data-yahoo getBarsMulti for live use.
 */
function runSettlement({ file = LEDGER_PATH, calibrationFile = CALIBRATION_PATH, barsBySymbol = {}, asOf = todayUTC(), write = true } = {}) {
  const rows = readLedger({ file });
  const { rows: settledRows, settledCount, openCount } = settle(rows, barsResolver(barsBySymbol), { asOf });
  const summary = computeCalibration(settledRows, {});
  if (write) {
    _ensureDir(calibrationFile);
    fs.writeFileSync(calibrationFile, JSON.stringify({ asOf, ...summary }, null, 2));
  }
  return { summary, settledRows, settledCount, openCount };
}

module.exports = {
  // schema + I/O
  makeRow, appendPrediction, readLedger,
  // settlement
  isMatured, addDays, settle, barsResolver, runSettlement,
  // calibration
  brierScore, decileHitRates, reliabilityTable, computeCalibration,
  // paths (for callers/tests)
  LEDGER_PATH, CALIBRATION_PATH,
};
