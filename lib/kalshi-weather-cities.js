"use strict";

/**
 * Weather-oracle city registry (#2220) — turns "which city" into DATA the oracle reads,
 * not code. Each entry pins the two external anchors that must be the SAME source for the
 * edge to exist (prediction target === settlement source): the Kalshi series and the NWS
 * station its Daily Climatological Report settles on. The oracle (kalshi-weather-edge.js)
 * reads a city's `normals` / `defaultNormal` / `ceilingTable` via paramsForCity.
 *
 * CERTIFICATION IS THE GATE, NOT PRESENCE. Only NYC currently carries a fitted model
 * (data/kalshi/weather-oracle-params.json, n=1818) AND a validated ≥100°F ceiling record,
 * so only NYC is `certified: true`. Every other city is listed so the surface is real and
 * discoverable, but `certified: false` — it may be MONITORED (read-only, cross-venue, or
 * calibration data-collection) but must NOT emit tradeable edges until it has its own fit.
 * Non-NYC `normals` are deliberately null (no invented NCEI numbers); `defaultNormal` is a
 * coarse summer placeholder used only for display/monitoring, never for a certified trade.
 *
 * Stations are the NWS ASOS the corresponding Kalshi high-temp series settles on.
 */

// NYC — the one certified city. Normals mirror kalshi-weather-edge DEFAULT_PARAMS.normals
// (NCEI 1991-2020, KNYC/Central Park); ceilingTable is left to the fitted params/defaults.
const NYC = {
  series: "KXHIGHNY",
  station: "KNYC",
  label: "NYC (Central Park)",
  tzOffsetH: -4, // EDT — summer-only series
  normals: {
    "6-25": 82.5, "6-26": 82.7, "6-27": 82.9, "6-28": 83.2, "6-29": 83.4,
    "6-30": 83.6, "7-1": 83.8, "7-2": 83.9, "7-3": 84.1, "7-4": 84.3, "7-5": 84.4,
  },
  defaultNormal: 84.0,
  ceilingTable: null,   // use the fitted/default NYC ceiling in kalshi-weather-edge
  certified: true,
  fit: "data/kalshi/weather-oracle-params.json",
};

// Uncertified cities: real series + settlement station, NO fitted model yet. certified:false
// gates trading; these exist for monitoring + as fit targets. Do not invent normals/ceilings.
const UNCERTIFIED = [
  { series: "KXHIGHCHI",  station: "KMDW", label: "Chicago (Midway)",     tzOffsetH: -5, defaultNormal: 84 },
  { series: "KXHIGHDEN",  station: "KDEN", label: "Denver",               tzOffsetH: -6, defaultNormal: 88 },
  { series: "KXHIGHMIA",  station: "KMIA", label: "Miami",                tzOffsetH: -4, defaultNormal: 90 },
  { series: "KXHIGHAUS",  station: "KAUS", label: "Austin (Camp Mabry)",  tzOffsetH: -5, defaultNormal: 96 },
  { series: "KXHIGHLAX",  station: "KLAX", label: "Los Angeles (LAX)",    tzOffsetH: -7, defaultNormal: 75 },
  { series: "KXHIGHPHIL", station: "KPHL", label: "Philadelphia",         tzOffsetH: -4, defaultNormal: 86 },
].map((c) => ({ ...c, normals: null, ceilingTable: null, certified: false, fit: null }));

const CITIES = [NYC, ...UNCERTIFIED];
const BY_SERIES = new Map(CITIES.map((c) => [c.series, c]));
const BY_STATION = new Map(CITIES.map((c) => [c.station, c]));

/** Look up a city by Kalshi series ("KXHIGHNY") or NWS station ("KNYC"). null if unknown. */
function getCity(key) {
  const k = String(key || "").toUpperCase();
  return BY_SERIES.get(k) || BY_STATION.get(k) || null;
}

/** Certified cities only — the ones an Act stage may trade. */
function certifiedCities() {
  return CITIES.filter((c) => c.certified);
}

/** True iff `key` names a city cleared to emit tradeable edges. */
function isCertified(key) {
  const c = getCity(key);
  return !!(c && c.certified);
}

module.exports = { CITIES, getCity, certifiedCities, isCertified, NYC };
