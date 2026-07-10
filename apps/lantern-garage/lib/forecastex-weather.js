"use strict";

/**
 * ForecastEx weather-venue registry (#2217) — pins the external anchors for the ForecastEx
 * NYC daily-high port the same way kalshi-weather-cities does for Kalshi series. This is
 * DATA + params loading only: no orders, no deck. Trading additionally requires the IBKR
 * EC entitlement (docs/research/2026-07-08-forecastex-probe-findings.md — account gap, an
 * Alex/IBKR action), a forward-verified fit, and its own ADR-gated Act path.
 *
 * SETTLEMENT (grounded 2026-07-10, docs/research/2026-07-10-forecastex-uhlga-settlement-
 * and-klga-fit.md): the venue's ONLY live NYC daily-high product is the U-series `UHLGA`
 * (CFTC product code U[H][LGA]) settling on Weather Underground's daily high for the
 * LaGuardia station — measured ≡ round(max METAR tmpf), 14/14 vs published settlement
 * flips. It is NOT the Central-Park/KNYC report Kalshi KXHIGHNY settles on (the DH-series
 * that did settle on the NWS CLI is no longer listed — 0 DH products in the venue's own
 * product summary). LGA runs systematically warmer than Central Park, so Kalshi↔ForecastEx
 * NYC positions carry station BASIS RISK — see cross-venue-monitor.js.
 *
 * CERTIFICATION IS THE GATE, NOT PRESENCE (same contract as kalshi-weather-cities):
 * `certified: false` until the KLGA fit has forward-verified settled outcomes AND the
 * ceiling behavior is measured — LaGuardia reaches 100°F far more readily than Central
 * Park, so the KNYC ≥100 ceiling fade MUST NOT be assumed to exist on this station.
 */

const fs = require("fs");
const path = require("path");
const oracle = require("./kalshi-weather-edge");
const { forecastExFeeCents, makeFlatFee } = require("./forecastex-fees");

const KLGA_PARAMS_PATH = path.resolve(__dirname, "../../../data/kalshi/weather-oracle-params-klga.json");

// A ceiling that never binds (cap = 1 everywhere). Used when the station has NO fitted
// ceiling so the KNYC default table can never leak in and fabricate a ≥100 fade edge.
const NO_CEILING = [[99, 1], [104, 1]];

const NYC_LGA = {
  venue: "FORECASTEX",
  product: "UHLGA",
  conid: 853400786,          // IBKR secdef underlying (read-only probe, 2026-07-08)
  label: "NYC (LaGuardia)",
  station: "KLGA",           // settlement observations station (NWS ASOS at LGA)
  asosStation: "LGA",
  asosNetwork: "NY_ASOS",
  tzOffsetH: -4,             // EDT — summer series, same convention as the Kalshi registry
  // NWS CLI 1991-2020 climatology for KLGA (per-day table lives with the fit tooling;
  // the flat summer mean is enough for the tiny regressionK anomaly term at serve time).
  normals: null,
  defaultNormal: 84.2,       // measured: mean Jun-Aug CLI high_normal, KLGA (fetchCliNormals 2025)
  certified: false,
  fit: "data/kalshi/weather-oracle-params-klga.json",
};

/**
 * Load the KLGA-fitted params for oracle use. Returns { params, hasFittedCeiling, source }.
 * - σ/bias fields come from the fit file via the oracle's per-field validated loader.
 * - ceilingTable is trusted ONLY if the fit file itself carries one; otherwise it is
 *   replaced with the non-binding NO_CEILING (the loader's KNYC default is wrong for LGA).
 * - normals are overlaid from the venue entry (never the KNYC table).
 */
function loadVenueParams(file = KLGA_PARAMS_PATH, entry = NYC_LGA) {
  const loaded = oracle.loadParams(file);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* absent -> defaults */ }
  const hasFittedCeiling = !!(raw && Array.isArray(raw.ceilingTable) && raw.ceilingTable.length >= 2);
  const params = oracle.paramsForCity(entry, loaded);
  if (!hasFittedCeiling) params.ceilingTable = NO_CEILING;
  return { params, hasFittedCeiling, source: loaded._source };
}

module.exports = {
  NYC_LGA, loadVenueParams, NO_CEILING, KLGA_PARAMS_PATH,
  feeCents: forecastExFeeCents, makeFlatFee,
};
