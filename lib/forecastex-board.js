"use strict";

/**
 * ForecastEx public daily-data reader (#2217) — the READ-ONLY Observe leg for the
 * ForecastEx weather port.
 *
 * The exchange publishes its full board as public CSVs at
 * `https://www.forecastex.com/api/download?type={prices|pairs|summary}&date=YYYYMMDD`
 * — no IBKR account, entitlement, or auth required (verified 2026-07-10; served dates
 * reach back to at least 2026-02-03). This bypasses the CPAPI EC-entitlement gap that
 * blocked market data in docs/research/2026-07-08-forecastex-probe-findings.md.
 * Prices are END-OF-DAY closes — right for fits, settlement history, and cross-venue
 * monitoring; NOT a live quote feed.
 *
 * U-series temperature contract ids: `UHLGA_MMDDYY_TT` = "will the daily high in the
 * city EXCEED TT °F on the contract date?" (exceed = strictly greater — CFTC U-contract
 * terms, product code U[H/L/A][region]). The settled high is therefore the min threshold
 * whose YES settled at 0 when it sits exactly one above the max threshold that settled
 * at 1 (a "clean flip"). Measured: flip-implied highs equal round(max METAR tmpf) for
 * LGA on 14/14 settled days (Jun 2026) — see
 * docs/research/2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md.
 *
 * Pure parsing + one fail-soft fetch; NO order code (venue trading needs EC entitlement,
 * a fitted+verified station model, and its own ADR-gated Act path).
 */

const { parseCsv } = require("./kalshi-mos");

const BASE_URL = "https://www.forecastex.com/api/download";

/** `UHLGA_071026_95` -> { product:"UHLGA", date:"2026-07-10", thr:95 }. null if not ours. */
function parseContractId(id) {
  const m = String(id || "").match(/^([A-Z0-9]+)_(\d{2})(\d{2})(\d{2})_(-?\d+)$/);
  if (!m) return null;
  return { product: m[1], date: `20${m[4]}-${m[2]}-${m[3]}`, thr: parseInt(m[5], 10) };
}

/** YES rows of one product from a parsed prices CSV, with id fields attached. */
function yesRows(rows, product) {
  const out = [];
  for (const r of rows || []) {
    if (r.subtype !== "YES") continue;
    const p = parseContractId(r.event_contract);
    if (!p || p.product !== product) continue;
    out.push({ ...p, row: r });
  }
  return out;
}

/**
 * Settled highs from settlement prices. Returns Map(dateISO -> {high, maxYes, minNo, clean}).
 * clean=true (high is exact) only on a clean flip: minNo === maxYes + 1. Otherwise high=null
 * and the bounds are reported — never guess a settlement.
 */
function settledHighs(rows, product) {
  const byDate = new Map();
  for (const { date, thr, row } of yesRows(rows, product)) {
    const s = parseFloat(row.settlement_price);
    if (!Number.isFinite(s)) continue;
    if (!byDate.has(date)) byDate.set(date, { maxYes: null, minNo: null });
    const d = byDate.get(date);
    if (s >= 0.999 && (d.maxYes == null || thr > d.maxYes)) d.maxYes = thr;
    if (s <= 0.001 && (d.minNo == null || thr < d.minNo)) d.minNo = thr;
  }
  const out = new Map();
  for (const [date, d] of byDate) {
    const clean = d.maxYes != null && d.minNo != null && d.minNo === d.maxYes + 1;
    out.set(date, { high: clean ? d.minNo : null, maxYes: d.maxYes, minNo: d.minNo, clean });
  }
  return out;
}

/**
 * EOD cumulative board for one product+contract date: sorted [{thr, yes}] where yes is the
 * YES close (end_price) ≈ P(high > thr). Thresholds with unusable prices are skipped.
 */
function thresholdBoard(rows, product, contractDate) {
  const board = [];
  for (const { date, thr, row } of yesRows(rows, product)) {
    if (date !== contractDate) continue;
    const yes = parseFloat(row.end_price);
    if (!Number.isFinite(yes)) continue;
    board.push({ thr, yes });
  }
  board.sort((a, b) => a.thr - b.thr);
  return board;
}

/** Contract dates present for a product in a prices CSV, sorted ascending. */
function contractDates(rows, product) {
  return [...new Set(yesRows(rows, product).map((r) => r.date))].sort();
}

/**
 * Range probability from the cumulative board: P(lo <= high <= hi) with integer °F buckets.
 *   P(high in [lo,hi]) = P(high > lo-1) - P(high > hi)  (strict-exceed convention)
 * Open tails: lo=null -> P(high <= hi) = 1 - P(high > hi); hi=null -> P(high >= lo).
 * Returns null when a needed threshold is not on the board — never extrapolate.
 */
function rangeYes(board, lo, hi) {
  const at = new Map(board.map((b) => [b.thr, b.yes]));
  const above = (t) => (at.has(t) ? at.get(t) : null);
  if (lo == null && hi == null) return null;
  if (lo == null) { const a = above(hi); return a == null ? null : Math.max(0, 1 - a); }
  if (hi == null) return above(lo - 1);
  const a = above(lo - 1), b = above(hi);
  if (a == null || b == null) return null;
  return Math.max(0, a - b);
}

/**
 * Project the cumulative board onto a Kalshi-style ladder [[label, lo, hi], ...] producing
 * the normalized bucket shape cross-venue-monitor.alignBuckets expects. Buckets the board
 * can't price are omitted (alignment simply won't match them).
 */
function toRangeBuckets(board, ladder, venueTicker = null) {
  const out = [];
  for (const [label, lo, hi] of ladder || []) {
    const yes = rangeYes(board, lo, hi);
    if (yes == null) continue;
    out.push({ lo: lo == null ? null : lo, hi: hi == null ? null : hi, label, yes, venueTicker });
  }
  return out;
}

/** Fetch + parse one daily CSV. Fail-soft: null on any error (never throws, never fabricates). */
async function fetchDailyCsv(type, dateYYYYMMDD, { timeoutMs = 20000 } = {}) {
  try {
    const r = await fetch(`${BASE_URL}?type=${type}&date=${dateYYYYMMDD}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "keystone-os-forecastex-board (github.com/lantern-os)" },
    });
    if (!r.ok) return null;
    return parseCsv(await r.text());
  } catch {
    return null;
  }
}

module.exports = {
  parseContractId, yesRows, settledHighs, thresholdBoard, contractDates,
  rangeYes, toRangeBuckets, fetchDailyCsv, BASE_URL,
};
