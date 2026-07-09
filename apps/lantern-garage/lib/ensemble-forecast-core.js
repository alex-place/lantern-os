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

// ── Proxy data feed (WIRED, #2239) ───────────────────────────────────────────
// Ensemble proxy = a TIME-LAGGED ensemble from NWS NBM/NBS MOS: within a fetch window each
// model RUN forecasting the target local day contributes one member (its max-over-day tmp).
// This is the cheap, free, honest proxy the scoping prescribed — NOT GenCast and NOT a
// same-init perturbed ensemble; it conflates lead-time with spread, and that caveat rides
// with any G1 number it produces. Source: IEM (mesonet.agron.iastate.edu), same endpoints the
// oracle's fit tool uses. Settled highs = ASOS hourly max (proxy for the NWS CLI daily high).
const km = require("./kalshi-mos");

const IEM_MOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py";
const IEM_ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const UA = { "User-Agent": "keystone-os-weather-gencast-g1 (github.com/lantern-os)" };

async function _get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`IEM HTTP ${r.status} for ${url}`);
  return r.text();
}

// km.localDayOf returns { key: "2025-7-3", ... } — UNPADDED, so its key can't be string-sorted.
// Canonicalize to zero-padded "YYYY-MM-DD" so date comparisons and joins are correct.
function _dayKey(ts, offsetH) {
  const ld = km.localDayOf(ts, offsetH);
  return ld ? `${ld.y}-${String(ld.m).padStart(2, "0")}-${String(ld.day).padStart(2, "0")}` : null;
}

/** Fetch NBS(NBM) MOS rows for a station over [stsUtcISO, etsUtcISO]. Returns parsed CSV rows. */
async function fetchMosRows(station, stsUtcISO, etsUtcISO, model = "NBS") {
  const url = `${IEM_MOS}?station=${encodeURIComponent(station)}&model=${model}&sts=${stsUtcISO}&ets=${etsUtcISO}&format=csv`;
  return km.parseCsv(await _get(url));
}

/** Time-lagged ensemble for one target local day: each RUN's max hourly tmp over that day = a
 *  member. `runDayFilter(runDayKey, targetDayKey)` selects which runs count (default: the day
 *  before — a clean ~1-day-lead ensemble). */
function timeLaggedEnsemble(rows, targetDayKey, { offsetH = -4, runDayFilter } = {}) {
  const keep = runDayFilter || ((runDay) => runDay < targetDayKey); // any run BEFORE the target day
  const byRun = new Map();
  for (const r of rows) {
    const t = parseFloat(r.tmp);
    if (!Number.isFinite(t)) continue;
    if (_dayKey(r.ftime, offsetH) !== targetDayKey) continue;     // forecast valid on target day
    const runDay = _dayKey(r.runtime, offsetH);
    if (!keep(runDay, targetDayKey)) continue;
    const key = r.runtime;
    const cur = byRun.get(key);
    if (cur == null || t > cur.tmp) byRun.set(key, { tmp: t, runDay });
  }
  const runs = [...byRun.values()].sort((a, b) => (a.runDay < b.runDay ? -1 : 1));
  return { members: runs.map((r) => r.tmp), runCount: runs.length };
}

/** ASOS hourly-max settled daily highs {localDayKey -> high °F} over a window (UTC year/month/day). */
async function fetchSettledHighs(asosStation, network, s, e, offsetH = -4) {
  const url = `${IEM_ASOS}?station=${encodeURIComponent(asosStation)}&network=${encodeURIComponent(network)}`
    + `&data=tmpf&year1=${s.y}&month1=${s.m}&day1=${s.d}&year2=${e.y}&month2=${e.m}&day2=${e.d}`
    + `&tz=Etc/UTC&format=onlycomma&missing=empty`;
  const rows = km.parseCsv(await _get(url));
  const byDay = new Map();
  for (const r of rows) {
    const t = parseFloat(r.tmpf);
    if (!Number.isFinite(t)) continue;
    const day = _dayKey(r.valid, offsetH);
    if (!day) continue;
    const cur = byDay.get(day);
    if (cur == null || t > cur) byDay.set(day, t);
  }
  return byDay;
}

/** Single-day convenience wrapper: fetch the day-ahead MOS window and return the ensemble members. */
async function fetchEnsembleProxy(station, targetDayKey, { model = "NBS", offsetH = -4 } = {}) {
  const sts = `${targetDayKey}T00:00Z`;               // 2 days back → day after, to capture prior runs
  const back = new Date(Date.parse(sts) - 2 * 86400000).toISOString().slice(0, 16) + "Z";
  const fwd = new Date(Date.parse(sts) + 1 * 86400000).toISOString().slice(0, 16) + "Z";
  const rows = await fetchMosRows(station, back, fwd, model);
  return timeLaggedEnsemble(rows, targetDayKey, { offsetH });
}

module.exports = {
  ensembleToBucketDist, climatologyDist, oracleDist, gradeSeries, backtestG1,
  fetchMosRows, timeLaggedEnsemble, fetchSettledHighs, fetchEnsembleProxy,
};
