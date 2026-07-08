"use strict";

/**
 * Ensemble forecast-core — Phase-0 harness for the GenCast experiment (#2239).
 *
 * MEASUREMENT ONLY, no trading. Two pieces, both pure:
 *   1. ensembleToBucketDist — the adapter: a set of ensemble-member daily-high forecasts →
 *      a bucket distribution over the contract ladder (the shape a temp-ladder contract needs).
 *   2. backtestG1 — Gate G1 from the scoping doc: grade the ensemble distribution vs the
 *      current hand-tuned oracle vs climatology on SETTLED highs, using the SAME RPS/PIT math
 *      the live verifier uses (kalshi-weather-verify) — so the number is directly comparable.
 *
 * This tests whether a calibrated ensemble is even a better *forecaster* than the crude
 * Gaussian+ceiling core, BEFORE any market/EV question (Gate G2) and long before GenCast infra.
 * The proxy data source (NWS NBM probabilistic Tmax / ECMWF open ENS) is deliberately NOT wired
 * here — `fetchEnsembleProxy` throws so a placeholder is never mistaken for a live feed.
 *
 * Reuses: kalshi-weather-verify (settledBucketFromHigh, distVector, rps, pit),
 *         kalshi-weather-edge (calibratedDistribution) for the incumbent-oracle comparison.
 */

const wv = require("./kalshi-weather-verify");
const edge = require("./kalshi-weather-edge");

/**
 * Adapter: histogram ensemble member highs into the contract ladder → normalized distribution.
 * Uses the verifier's settledBucketFromHigh for binning so a member and a settled high land in
 * the SAME bucket by construction. Non-finite members are dropped; an empty/degenerate set
 * falls back to a flat distribution (no false confidence).
 * @param {number[]} members  ensemble member daily-high forecasts (°F)
 * @param {Array} ladder      [[label, loF|null, hiF|null], ...]
 * @returns {Object}          { label: probability } summing to 1
 */
function ensembleToBucketDist(members, ladder) {
  if (!Array.isArray(ladder) || !ladder.length) return {};
  const counts = new Array(ladder.length).fill(0);
  let valid = 0;
  for (const h of members || []) {
    if (!Number.isFinite(h)) continue;
    const idx = wv.settledBucketFromHigh(ladder, h);
    if (idx >= 0 && idx < ladder.length) { counts[idx]++; valid++; }
  }
  const out = {};
  ladder.forEach(([lbl], i) => { out[lbl] = valid ? counts[i] / valid : 1 / ladder.length; });
  return out;
}

/** Climatological baseline: a flat forecast over the ladder — the "know nothing" reference RPS. */
function climatologyDist(ladder) {
  const out = {};
  const k = ladder.length || 1;
  for (const [lbl] of ladder) out[lbl] = 1 / k;
  return out;
}

/** The incumbent oracle's distribution for a day (reuses the fitted calibratedDistribution). */
function oracleDist(day) {
  return edge.calibratedDistribution(day.forecastHigh, day.leadDays, day.ladder, day.month, day.day);
}

/** Mean RPS + mean PIT over a series of {dist, ladder, settledHigh}, using the verifier's math. */
function gradeSeries(records) {
  const rpsVals = [], pitVals = [];
  for (const r of records) {
    const obsIdx = wv.settledBucketFromHigh(r.ladder, r.settledHigh);
    if (obsIdx < 0 || obsIdx >= r.ladder.length) continue;
    const vec = wv.distVector(r.dist, r.ladder);
    rpsVals.push(wv.rps(vec, obsIdx));
    pitVals.push(wv.pit(vec, obsIdx));
  }
  const n = rpsVals.length;
  return {
    n,
    meanRPS: n ? rpsVals.reduce((s, x) => s + x, 0) / n : null,
    pit: n ? wv.pitUniformity(pitVals) : null,
  };
}

/**
 * Gate G1: does the ensemble beat the oracle beat climatology on RPS, out-of-sample?
 * @param {Array} days  [{ members, ladder, settledHigh, forecastHigh, leadDays, month, day }]
 * @returns {Object}    per-model meanRPS + verdict
 */
function backtestG1(days = []) {
  const proxyRecs = [], oracleRecs = [], climoRecs = [];
  for (const d of days) {
    if (!Array.isArray(d.ladder) || !d.ladder.length || !Number.isFinite(d.settledHigh)) continue;
    proxyRecs.push({ dist: ensembleToBucketDist(d.members, d.ladder), ladder: d.ladder, settledHigh: d.settledHigh });
    oracleRecs.push({ dist: oracleDist(d), ladder: d.ladder, settledHigh: d.settledHigh });
    climoRecs.push({ dist: climatologyDist(d.ladder), ladder: d.ladder, settledHigh: d.settledHigh });
  }
  const proxy = gradeSeries(proxyRecs), oracle = gradeSeries(oracleRecs), climo = gradeSeries(climoRecs);
  const active = proxy.n >= wv.MIN_SAMPLES;
  const beatsOracle = proxy.meanRPS != null && oracle.meanRPS != null && proxy.meanRPS < oracle.meanRPS;
  const beatsClimo = proxy.meanRPS != null && climo.meanRPS != null && proxy.meanRPS < climo.meanRPS;
  return {
    n: proxy.n, active,
    meanRPS: { proxy: proxy.meanRPS, oracle: oracle.meanRPS, climatology: climo.meanRPS },
    pit: { proxy: proxy.pit, oracle: oracle.pit },
    beatsOracle, beatsClimo,
    // G1 passes only with enough settled days AND the ensemble beating BOTH references.
    verdict: !active ? "insufficient-data" : (beatsOracle && beatsClimo ? "ensemble-wins-G1" : "no-improvement"),
    report: !active
      ? `n=${proxy.n} settled days (need ${wv.MIN_SAMPLES}) — G1 undecided; stand down.`
      : `RPS proxy ${fmt(proxy.meanRPS)} vs oracle ${fmt(oracle.meanRPS)} vs climo ${fmt(climo.meanRPS)} — `
        + (beatsOracle && beatsClimo ? "ensemble is the better forecaster (proceed to G2 vs market)."
          : "no forecasting improvement — not worth a market test, let alone GenCast."),
  };
}

const fmt = (x) => (x == null ? "—" : x.toFixed(4));

/** Proxy data source — NOT wired. Building the ensemble feed (NWS NBM probabilistic Tmax or
 *  ECMWF open ENS, per-station) is the Phase-0 data step; do that behind the market-data client
 *  and feed backtestG1. Throws so a placeholder is never mistaken for a live feed (#2239). */
function fetchEnsembleProxy(_station, _date) {
  throw new Error("ensemble proxy not wired — Phase-0 data step (NBM prob-Tmax / ECMWF ENS) pending (#2239)");
}

module.exports = { ensembleToBucketDist, climatologyDist, oracleDist, gradeSeries, backtestG1, fetchEnsembleProxy };
