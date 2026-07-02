"use strict";

/**
 * NWS daily-high forecast adapter — the Observe leg for the Σ₀ weather-edge deck.
 *
 * Kalshi KXHIGHNY settles on the NWS Daily Climatological Report for Central Park
 * (KNYC), whose forecast gridpoint is OKX 34,45. We pull the official NWS gridpoint
 * forecast and return date -> daytime-high °F. This is the ONLY live input to the
 * calibrated model, so it must never go stale: the research note's hardcoded line had
 * already drifted 1-2 °F below reality within a day (Jul 2 101->100, Jul 3 102->100).
 *
 * Cached ~30 min (NWS updates a few times/hour; the deck re-polls every 5s and must
 * not hammer weather.gov). Fails soft: returns {} on any error so the deck degrades to
 * "no forecast — stand down" rather than trading on a stale constant.
 */

// series_ticker -> NWS forecast gridpoint (office, gridX,gridY). Central Park / KNYC.
const SERIES_GRIDPOINT = {
  KXHIGHNY: { office: "OKX", grid: "34,45", station: "KNYC (Central Park)" },
};

const CACHE_MS = 30 * 60 * 1000;
const _cache = new Map();   // series -> { at, byDate }

function _startDate(iso) {
  // NWS period.startTime like "2026-07-02T06:00:00-04:00" -> "7-2" month-day key + Date.
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  return { key: `${month}-${day}`, month, day, ymd: `${m[1]}-${m[2]}-${m[3]}` };
}

async function _fetchGridpoint(office, grid) {
  const url = `https://api.weather.gov/gridpoints/${office}/${grid}/forecast`;
  const r = await fetch(url, {
    headers: {
      // NWS requires a descriptive User-Agent; anonymous requests are throttled/blocked.
      "User-Agent": "keystone-os-kalshi-weather-edge (github.com/lantern-os; contact via repo)",
      "Accept": "application/geo+json",
    },
  });
  if (!r.ok) throw new Error(`NWS ${office}/${grid} HTTP ${r.status}`);
  const j = await r.json();
  const periods = (j && j.properties && j.properties.periods) || [];
  const byDate = {};
  for (const p of periods) {
    if (!p.isDaytime) continue;                // daytime period == the daily high
    const d = _startDate(p.startTime);
    if (!d) continue;
    const t = Number(p.temperature);
    if (!Number.isFinite(t)) continue;
    // keep the first (nearest) daytime reading per calendar date
    if (byDate[d.key] == null) {
      byDate[d.key] = { high: t, month: d.month, day: d.day, ymd: d.ymd, shortForecast: p.shortForecast || "" };
    }
  }
  return byDate;
}

/**
 * getForecastHighs(series) -> { "7-2": {high, month, day, ymd, shortForecast}, ... }
 * Returns {} on failure (deck stands down rather than using a stale constant).
 */
async function getForecastHighs(series = "KXHIGHNY") {
  const gp = SERIES_GRIDPOINT[series];
  if (!gp) return {};
  const c = _cache.get(series);
  if (c && Date.now() - c.at < CACHE_MS) return c.byDate;
  try {
    const byDate = await _fetchGridpoint(gp.office, gp.grid);
    _cache.set(series, { at: Date.now(), byDate });
    return byDate;
  } catch (e) {
    // serve last good cache if we have one; else empty
    if (c) return c.byDate;
    return {};
  }
}

function gridpointFor(series) { return SERIES_GRIDPOINT[series] || null; }

module.exports = { getForecastHighs, gridpointFor, SERIES_GRIDPOINT };
