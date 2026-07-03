"use strict";

/**
 * Generic NWS point/hourly forecast adapter — the Observe leg for the paper MLB weather
 * deck. Given a lat/lon and a target time (first pitch), returns the game-time surface
 * conditions the run-total model needs: { tempF, windMph, windFromDeg, precipProb }.
 *
 * Two-hop NWS flow, each cached to respect weather.gov (no anonymous hammering):
 *   1. /points/{lat},{lon} → the station's forecastHourly URL + grid id (cached long;
 *      a park never moves).
 *   2. that hourly URL → per-hour periods (cached ~30 min).
 * Fails soft everywhere: any error → null, and the deck treats a null forecast as
 * "can't ground this game → skip", never as calm.
 */

const POINTS_CACHE = new Map();   // "lat,lon" -> { hourlyUrl, grid }
const HOURLY_CACHE = new Map();   // hourlyUrl -> { at, periods }
const HOURLY_TTL_MS = 30 * 60 * 1000;

const UA = "keystone-os-kalshi-mlb-weather (github.com/lantern-os; contact via repo)";

// 16-point compass (direction wind comes FROM) → degrees.
const COMPASS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function cardinalToDeg(c) {
  const k = String(c || "").toUpperCase().trim();
  return Object.prototype.hasOwnProperty.call(COMPASS, k) ? COMPASS[k] : null;
}
function mphFromWindSpeed(s) {
  // NWS hourly windSpeed looks like "5 mph" or occasionally "5 to 10 mph"; take the max.
  const nums = String(s || "").match(/\d+/g);
  if (!nums) return null;
  return Math.max(...nums.map(Number));
}

async function _get(url, accept) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept || "application/geo+json" } });
  if (!r.ok) throw new Error(`NWS HTTP ${r.status} ${url}`);
  return r.json();
}

async function _resolveHourlyUrl(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (POINTS_CACHE.has(key)) return POINTS_CACHE.get(key);
  const j = await _get(`https://api.weather.gov/points/${lat},${lon}`);
  const hourlyUrl = j && j.properties && j.properties.forecastHourly;
  if (!hourlyUrl) throw new Error("no forecastHourly in points response");
  const rec = { hourlyUrl, grid: j.properties.gridId + "/" + j.properties.gridX + "," + j.properties.gridY };
  POINTS_CACHE.set(key, rec);
  return rec;
}

async function _hourlyPeriods(hourlyUrl) {
  const c = HOURLY_CACHE.get(hourlyUrl);
  if (c && Date.now() - c.at < HOURLY_TTL_MS) return c.periods;
  const j = await _get(hourlyUrl);
  const periods = (j && j.properties && j.properties.periods) || [];
  HOURLY_CACHE.set(hourlyUrl, { at: Date.now(), periods });
  return periods;
}

/** Pick the hourly period whose [startTime,endTime) contains targetMs (else nearest). */
function _periodAt(periods, targetMs) {
  let best = null, bestGap = Infinity;
  for (const p of periods) {
    const s = Date.parse(p.startTime), e = Date.parse(p.endTime || p.startTime);
    if (Number.isFinite(s)) {
      if (targetMs >= s && targetMs < (Number.isFinite(e) ? e : s + 3600000)) return p;
      const gap = Math.min(Math.abs(targetMs - s), Number.isFinite(e) ? Math.abs(targetMs - e) : Infinity);
      if (gap < bestGap) { bestGap = gap; best = p; }
    }
  }
  return best;
}

/**
 * getGameConditions(lat, lon, targetIso) →
 *   { tempF, windMph, windFromDeg, precipProb, grid, when } | null
 */
async function getGameConditions(lat, lon, targetIso) {
  try {
    const targetMs = Date.parse(targetIso);
    if (!Number.isFinite(targetMs)) return null;
    const { hourlyUrl, grid } = await _resolveHourlyUrl(lat, lon);
    const periods = await _hourlyPeriods(hourlyUrl);
    const p = _periodAt(periods, targetMs);
    if (!p) return null;
    const precip = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
    return {
      tempF: Number(p.temperature),
      windMph: mphFromWindSpeed(p.windSpeed),
      windFromDeg: cardinalToDeg(p.windDirection),
      precipProb: Number.isFinite(precip) ? precip / 100 : 0,
      shortForecast: p.shortForecast || "",
      grid,
      when: p.startTime,
    };
  } catch {
    return null;
  }
}

module.exports = { getGameConditions, cardinalToDeg, mphFromWindSpeed };
