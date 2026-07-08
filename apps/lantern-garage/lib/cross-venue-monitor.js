"use strict";

/**
 * Cross-venue divergence monitor (#2221) — READ-ONLY. Kalshi (KXHIGHNY) and IBKR ForecastEx
 * list the same NYC daily-high contract and settle on the IDENTICAL KNYC Daily Climatological
 * Report, but keep separate order books. When the same temperature bucket is priced apart on
 * the two books by more than the (tiny) combined fee, that gap is a near-market-neutral arb:
 * buy the cheaper YES, sell the dearer YES (or its NO). This module only DETECTS and reports
 * such gaps — it contains NO order code and never will; orders are a separate, gated step
 * taken only after divergence is shown to exist and be fillable.
 *
 * Buckets are matched by their [lo, hi] °F range, NOT by ticker/label — the two venues use
 * different symbols for the same outcome, but the settlement temperature ranges are the same.
 *
 * Board contract (both venues, normalized by the caller):
 *   [{ lo:Number|null, hi:Number|null, label:String, yes:Number(0..1), venueTicker?:String }]
 * `yes` is the YES ask (or mid) as a probability. Open-ended tails use lo=null / hi=null.
 */

const { kalshiFeeCents } = require("./kalshi-weather-edge");
const { forecastExFeeCents } = require("./forecastex-fees");

const rangeKey = (b) => `${b.lo == null ? "-inf" : b.lo}..${b.hi == null ? "+inf" : b.hi}`;

/** Join two normalized boards on their [lo,hi] range. Returns aligned rows for buckets that
 *  appear on BOTH books (the only ones an arb can span), plus the unmatched keys for audit. */
function alignBuckets(kalshiBoard = [], forecastexBoard = []) {
  const fexByRange = new Map(forecastexBoard.map((b) => [rangeKey(b), b]));
  const seen = new Set();
  const aligned = [];
  for (const k of kalshiBoard) {
    const key = rangeKey(k);
    const f = fexByRange.get(key);
    if (f && Number.isFinite(k.yes) && Number.isFinite(f.yes)) {
      aligned.push({ key, lo: k.lo, hi: k.hi, label: k.label || f.label, kalshi: k, forecastex: f });
      seen.add(key);
    }
  }
  const kalshiKeys = new Set(kalshiBoard.map(rangeKey));
  return {
    aligned,
    kalshiOnly: kalshiBoard.filter((b) => !fexByRange.has(rangeKey(b))).map(rangeKey),
    forecastexOnly: forecastexBoard.filter((b) => !kalshiKeys.has(rangeKey(b))).map(rangeKey),
  };
}

/**
 * Flag aligned buckets whose YES prices diverge by MORE than the combined round-trip fee.
 * gapCents = |pK − pF|·100; netCents = gapCents − combinedFeeCents. A positive net is the
 * reliable, fee-covered edge (analogous to worst_c in the single-venue gate).
 *
 * @param {object} alignment  output of alignBuckets
 * @param {object} opts
 *   minNetCents   extra cushion beyond fees before flagging (default 1)
 *   kalshiFee     feeCents(price)->cents for Kalshi (default kalshiFeeCents)
 *   forecastexFee feeCents(price)->cents for ForecastEx (default forecastExFeeCents)
 */
function findDivergences(alignment, opts = {}) {
  const { minNetCents = 1, kalshiFee = kalshiFeeCents, forecastexFee = forecastExFeeCents } = opts;
  const flags = [];
  for (const row of alignment.aligned) {
    const pK = row.kalshi.yes, pF = row.forecastex.yes;
    const gapCents = Math.abs(pK - pF) * 100;
    // Fee to LIFT the cheaper YES + fee to SELL (buy the NO of) the dearer YES.
    const buyKalshi = pK < pF;
    const combinedFeeCents = buyKalshi
      ? kalshiFee(pK) + forecastexFee(1 - pF)
      : forecastexFee(pF) + kalshiFee(1 - pK);
    const netCents = gapCents - combinedFeeCents;
    if (netCents >= minNetCents) {
      flags.push({
        bucket: row.label, range: row.key,
        kalshiYes: Math.round(pK * 1000) / 10, forecastexYes: Math.round(pF * 1000) / 10,
        gapCents: Math.round(gapCents * 10) / 10,
        combinedFeeCents: Math.round(combinedFeeCents * 10) / 10,
        netCents: Math.round(netCents * 10) / 10,
        // near-market-neutral leg direction (read-only suggestion, NOT an order)
        buy: buyKalshi ? "kalshi-YES" : "forecastex-YES",
        sell: buyKalshi ? "forecastex-YES" : "kalshi-YES",
        kalshiTicker: row.kalshi.venueTicker || null,
        forecastexTicker: row.forecastex.venueTicker || null,
      });
    }
  }
  flags.sort((a, b) => b.netCents - a.netCents);
  return flags;
}

/** One-call read-only report over two boards. Pure — the caller supplies both snapshots
 *  (Kalshi live; ForecastEx once #2216 wires the board pull). */
function crossVenueReport(kalshiBoard, forecastexBoard, opts = {}) {
  const alignment = alignBuckets(kalshiBoard, forecastexBoard);
  const flags = findDivergences(alignment, opts);
  return {
    mode: "read-only",
    alignedBuckets: alignment.aligned.length,
    kalshiOnly: alignment.kalshiOnly,
    forecastexOnly: alignment.forecastexOnly,
    divergences: flags,
    note: flags.length
      ? `${flags.length} fee-covered divergence(s) — NEAR-neutral arb candidates, read-only. No order code; verify fillable depth (#2216) before any leg.`
      : "no cross-venue divergence beyond combined fees — books agree (the expected, efficient case).",
  };
}

module.exports = { alignBuckets, findDivergences, crossVenueReport, rangeKey };
