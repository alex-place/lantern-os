"use strict";

/**
 * NBS (NBM) MOS daily-high forecast adapter — the Observe leg for the Σ₀ weather-edge deck.
 *
 * WHY MOS instead of the gridded NWS forecast (kalshi-nws.js): the oracle's distribution
 * constants are CALIBRATED against settled NWS-CLI highs (#1871), and that calibration was fit
 * with NBS MOS as the forecast input. Serving must use the SAME forecast source the constants
 * were fit against — otherwise a train/serve skew mis-applies the ~1.5°F MOS→CLI bias. This
 * module is the canonical owner of the MOS forecast-high definition; scripts/fit-* and
 * scripts/validate-* import the pure helpers from here so fit == serve by construction.
 *
 * Forecast high for a local day = max hourly `tmp` across the day's MOS rows (identical to the
 * fit). Per settlement day we take the most recent MOS run that covers it. Source:
 * IEM /cgi-bin/request/mos.py?station=KNYC&model=NBS&…&format=csv.
 *
 * Cached ~30 min; fails soft (returns {} — deck stands down rather than trading a stale value).
 */

const EASTERN_SUMMER_OFFSET_H = -4; // EDT; the weather-edge series trades summer only.

const SERIES_MOS = {
  KXHIGHNY: { station: "KNYC" },
};

const CACHE_MS = 30 * 60 * 1000;
const _cache = new Map(); // series -> { at, byDate }

// ── pure parsing (canonical; imported by the fit/validate tools) ────────────────

function parseCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((ln) => {
    const cells = ln.split(",");
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i] == null ? "" : cells[i].trim(); });
    return row;
  });
}

/** Shift a UTC timestamp by offsetH and return the local calendar day. */
function localDayOf(tsUtc, offsetH = EASTERN_SUMMER_OFFSET_H) {
  const s = String(tsUtc).replace(" ", "T").replace(/Z?$/, "Z");
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + offsetH * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return { key: `${y}-${m}-${day}`, mmdd: `${m}-${day}`, y, m, day };
}

/** MOS rows -> Map(runDayKey -> {run, days: Map(targetDayKey -> {tgt, high})}), where the
 *  forecast high for a target local day = max hourly `tmp`. IDENTICAL definition to the fit. */
function mosForecastHighs(rows) {
  const byRun = new Map();
  for (const r of rows) {
    const tmp = parseFloat(r.tmp);
    if (!Number.isFinite(tmp)) continue;
    const run = localDayOf(r.runtime);
    const tgt = localDayOf(r.ftime);
    if (!run || !tgt) continue;
    if (!byRun.has(run.key)) byRun.set(run.key, { run, days: new Map() });
    const days = byRun.get(run.key).days;
    const cur = days.get(tgt.key);
    if (!cur || tmp > cur.high) days.set(tgt.key, { tgt, high: tmp });
  }
  return byRun;
}

/** Collapse runs to one forecast per target day, taking the MOST RECENT run that covers it.
 *  Returns the deck's expected shape: { "m-d": {high, month, day, ymd, runtime} }. */
function latestForecastHighs(byRun) {
  const runTs = (r) => Date.UTC(r.y, r.m - 1, r.day);
  const runs = [...byRun.values()].sort((a, b) => runTs(b.run) - runTs(a.run));
  const pad = (n) => String(n).padStart(2, "0");
  const out = {};
  for (const { run, days } of runs) {
    for (const { tgt, high } of days.values()) {
      if (out[tgt.mmdd] == null) {
        out[tgt.mmdd] = {
          high: Math.round(high), month: tgt.m, day: tgt.day,
          ymd: `${tgt.y}-${pad(tgt.m)}-${pad(tgt.day)}`,
          shortForecast: "NBS MOS", runtime: run.key,
        };
      }
    }
  }
  return out;
}

// ── live fetch ──────────────────────────────────────────────────────────────

function _isoHourUTC(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00Z`;
}

async function _fetchMos(station, nowMs) {
  const sts = _isoHourUTC(nowMs - 36 * 3600 * 1000); // include last runs so nowcast/D+1 exist
  const ets = _isoHourUTC(nowMs + 8 * 86400 * 1000);
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${station}&model=NBS&sts=${sts}&ets=${ets}&format=csv`;
  const r = await fetch(url, { headers: { "User-Agent": "keystone-os-kalshi-weather-edge (github.com/lantern-os)" } });
  if (!r.ok) throw new Error(`IEM MOS ${station} HTTP ${r.status}`);
  return latestForecastHighs(mosForecastHighs(parseCsv(await r.text())));
}

/**
 * getForecastHighs(series) -> { "7-2": {high, month, day, ymd, shortForecast, runtime}, ... }
 * Same shape as kalshi-nws.getForecastHighs so the deck is a drop-in swap. {} on failure.
 */
async function getForecastHighs(series = "KXHIGHNY") {
  const cfg = SERIES_MOS[series];
  if (!cfg) return {};
  const c = _cache.get(series);
  const now = Date.now();
  if (c && now - c.at < CACHE_MS) return c.byDate;
  try {
    const byDate = await _fetchMos(cfg.station, now);
    _cache.set(series, { at: now, byDate });
    return byDate;
  } catch (e) {
    if (c) return c.byDate; // last good
    return {};
  }
}

module.exports = {
  getForecastHighs, latestForecastHighs, mosForecastHighs, localDayOf, parseCsv, SERIES_MOS,
};
