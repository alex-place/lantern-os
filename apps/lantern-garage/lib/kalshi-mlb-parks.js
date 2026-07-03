"use strict";

/**
 * MLB ballpark database + Kalshi game-code splitter — the static reference layer for
 * the paper KXMLBTOTAL weather deck (kalshi-mlb-weather-deck).
 *
 * WHY this exists: a run-total's weather sensitivity is a property of the PARK, not the
 * teams. Altitude (air density) and roof state gate whether wind/temperature can move
 * the ball at all; center-field azimuth decides whether a given wind is blowing OUT
 * (over) or IN (under). This module encodes only facts about the venues.
 *
 * HONESTY: every field here is a static, checkable venue fact — not a model output.
 *   - roof:  'open' | 'retractable' | 'fixed'   (fixed/dome ⇒ wind & temp neutralized)
 *   - altitudeFt: field elevation (Coors 5200ft is the one true outlier)
 *   - cfAzimuthDeg: compass bearing from home plate toward center field. MLB Rule 1.04
 *     only *recommends* ENE (~68°) and real parks vary up to ±90° from it, so a value
 *     here must be a VERIFIED per-park measurement, not the rulebook prior. None are
 *     verified yet ⇒ all null. A null azimuth suppresses the wind-VECTOR signal entirely
 *     (we will not guess out vs in from an unknown orientation — Σ₀: no claim without
 *     evidence); the deck still NOTES strong wind for human review. Wiring a verified
 *     orientation table is the immediate follow-up that turns the wind signal on.
 *   - runFactor: rough multi-year park run factor (1.00 = neutral). Coarse; used only as
 *     weak context, never as the edge itself.
 *
 * 2026 note: Tampa Bay plays at open-air Steinbrenner Field (Tropicana Field was storm-
 * damaged in 2024), and the Athletics play at open-air Sutter Health Park in Sacramento.
 * Both are marked roof:'open' with a `provisional` flag so the deck can lower confidence.
 */

// Canonical Kalshi MLB team codes as they appear in KXMLBTOTAL tickers (AWAYHOME
// concatenation). Observed live: CWS, ATH, AZ (not CHW/OAK/ARI). Verified against the
// live board 2026-07-02; the five not on that day's slate (BOS/CHC/HOU/SF/TOR) use their
// standard Kalshi abbreviations and are here for completeness.
const TEAM_CODES = [
  "ARI", "AZ", "ATL", "BAL", "BOS", "CHC", "CWS", "CIN", "CLE", "COL", "DET",
  "HOU", "KC", "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY", "ATH", "OAK",
  "PHI", "PIT", "SD", "SF", "SEA", "STL", "TB", "TEX", "TOR", "WSH",
];
const TEAM_CODE_SET = new Set(TEAM_CODES);

// home team code -> park facts. lat/lon locate the NWS forecast point. altitudeFt + roof
// are checkable venue facts; cfAzimuthDeg is null everywhere until a verified per-park
// orientation table is wired (see header) — the model suppresses the wind vector on null.
const PARKS = {
  ATL: { name: "Truist Park", lat: 33.890, lon: -84.468, altitudeFt: 1050, roof: "open", cfAzimuthDeg: null, runFactor: 1.02 },
  AZ:  { name: "Chase Field", lat: 33.445, lon: -112.067, altitudeFt: 1080, roof: "retractable", cfAzimuthDeg: null, runFactor: 1.03 },
  ARI: { name: "Chase Field", lat: 33.445, lon: -112.067, altitudeFt: 1080, roof: "retractable", cfAzimuthDeg: null, runFactor: 1.03 },
  BAL: { name: "Camden Yards", lat: 39.284, lon: -76.622, altitudeFt: 20, roof: "open", cfAzimuthDeg: null, runFactor: 1.01 },
  BOS: { name: "Fenway Park", lat: 42.346, lon: -71.097, altitudeFt: 20, roof: "open", cfAzimuthDeg: null, runFactor: 1.04 },
  CHC: { name: "Wrigley Field", lat: 41.948, lon: -87.656, altitudeFt: 600, roof: "open", cfAzimuthDeg: null, runFactor: 1.00 },
  CWS: { name: "Rate Field", lat: 41.830, lon: -87.634, altitudeFt: 595, roof: "open", cfAzimuthDeg: null, runFactor: 1.01 },
  CIN: { name: "Great American Ball Park", lat: 39.097, lon: -84.507, altitudeFt: 490, roof: "open", cfAzimuthDeg: null, runFactor: 1.03 },
  CLE: { name: "Progressive Field", lat: 41.496, lon: -81.685, altitudeFt: 660, roof: "open", cfAzimuthDeg: null, runFactor: 0.98 },
  COL: { name: "Coors Field", lat: 39.756, lon: -104.994, altitudeFt: 5200, roof: "open", cfAzimuthDeg: null, runFactor: 1.12 },
  DET: { name: "Comerica Park", lat: 42.339, lon: -83.049, altitudeFt: 600, roof: "open", cfAzimuthDeg: null, runFactor: 0.97 },
  HOU: { name: "Daikin Park", lat: 29.757, lon: -95.356, altitudeFt: 50, roof: "retractable", cfAzimuthDeg: null, runFactor: 1.01 },
  KC:  { name: "Kauffman Stadium", lat: 39.051, lon: -94.480, altitudeFt: 750, roof: "open", cfAzimuthDeg: null, runFactor: 0.99 },
  LAA: { name: "Angel Stadium", lat: 33.800, lon: -117.883, altitudeFt: 160, roof: "open", cfAzimuthDeg: null, runFactor: 0.98 },
  LAD: { name: "Dodger Stadium", lat: 34.074, lon: -118.240, altitudeFt: 520, roof: "open", cfAzimuthDeg: null, runFactor: 0.96 },
  MIA: { name: "loanDepot park", lat: 25.778, lon: -80.220, altitudeFt: 10, roof: "retractable", cfAzimuthDeg: null, runFactor: 0.97 },
  MIL: { name: "American Family Field", lat: 43.028, lon: -87.971, altitudeFt: 630, roof: "retractable", cfAzimuthDeg: null, runFactor: 1.00 },
  MIN: { name: "Target Field", lat: 44.982, lon: -93.278, altitudeFt: 815, roof: "open", cfAzimuthDeg: null, runFactor: 1.00 },
  NYM: { name: "Citi Field", lat: 40.757, lon: -73.846, altitudeFt: 20, roof: "open", cfAzimuthDeg: null, runFactor: 0.95 },
  NYY: { name: "Yankee Stadium", lat: 40.829, lon: -73.926, altitudeFt: 55, roof: "open", cfAzimuthDeg: null, runFactor: 1.03 },
  ATH: { name: "Sutter Health Park", lat: 38.580, lon: -121.513, altitudeFt: 25, roof: "open", cfAzimuthDeg: null, runFactor: 1.00, provisional: true },
  OAK: { name: "Sutter Health Park", lat: 38.580, lon: -121.513, altitudeFt: 25, roof: "open", cfAzimuthDeg: null, runFactor: 1.00, provisional: true },
  PHI: { name: "Citizens Bank Park", lat: 39.906, lon: -75.166, altitudeFt: 20, roof: "open", cfAzimuthDeg: null, runFactor: 1.04 },
  PIT: { name: "PNC Park", lat: 40.447, lon: -80.006, altitudeFt: 730, roof: "open", cfAzimuthDeg: null, runFactor: 0.97 },
  SD:  { name: "Petco Park", lat: 32.707, lon: -117.157, altitudeFt: 15, roof: "open", cfAzimuthDeg: null, runFactor: 0.94 },
  SF:  { name: "Oracle Park", lat: 37.778, lon: -122.389, altitudeFt: 10, roof: "open", cfAzimuthDeg: null, runFactor: 0.90 },
  SEA: { name: "T-Mobile Park", lat: 47.591, lon: -122.332, altitudeFt: 10, roof: "retractable", cfAzimuthDeg: null, runFactor: 0.95 },
  STL: { name: "Busch Stadium", lat: 38.622, lon: -90.193, altitudeFt: 465, roof: "open", cfAzimuthDeg: null, runFactor: 0.99 },
  TB:  { name: "Steinbrenner Field", lat: 27.980, lon: -82.507, altitudeFt: 10, roof: "open", cfAzimuthDeg: null, runFactor: 1.00, provisional: true },
  TEX: { name: "Globe Life Field", lat: 32.747, lon: -97.084, altitudeFt: 550, roof: "retractable", cfAzimuthDeg: null, runFactor: 0.99 },
  TOR: { name: "Rogers Centre", lat: 43.641, lon: -79.389, altitudeFt: 260, roof: "retractable", cfAzimuthDeg: null, runFactor: 1.00 },
  WSH: { name: "Nationals Park", lat: 38.873, lon: -77.007, altitudeFt: 25, roof: "open", cfAzimuthDeg: null, runFactor: 1.00 },
};

/**
 * Split a Kalshi KXMLBTOTAL game code ("AWAYHOME", e.g. "STLATL", "TBKC", "MIAATH")
 * into { away, home } using the known team-code set. Codes are variable length (2–3)
 * and undelimited, so we try each valid suffix length and accept the split where BOTH
 * halves are known codes. Returns null if no unambiguous split exists.
 */
function splitGameCode(code) {
  const c = String(code || "").toUpperCase();
  const splits = [];
  for (const homeLen of [2, 3]) {
    if (c.length <= homeLen) continue;
    const home = c.slice(c.length - homeLen);
    const away = c.slice(0, c.length - homeLen);
    if (TEAM_CODE_SET.has(home) && TEAM_CODE_SET.has(away)) splits.push({ away, home });
  }
  // Unique split → trust it. Ambiguous (both 2- and 3-char suffix valid) → prefer the
  // one whose HOME has a park entry (the venue we actually forecast for).
  if (splits.length === 1) return splits[0];
  if (splits.length > 1) {
    const withPark = splits.filter((s) => PARKS[s.home]);
    return withPark.length === 1 ? withPark[0] : splits[0];
  }
  return null;
}

/** Home park for a Kalshi game code, or null. */
function parkForGameCode(code) {
  const s = splitGameCode(code);
  if (!s) return null;
  const park = PARKS[s.home];
  return park ? { ...park, homeCode: s.home, awayCode: s.away } : null;
}

module.exports = { PARKS, TEAM_CODES, TEAM_CODE_SET, splitGameCode, parkForGameCode };
