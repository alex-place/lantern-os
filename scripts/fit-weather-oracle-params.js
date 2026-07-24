"use strict";

/**
 * Fit the Σ₀ weather-oracle distribution parameters from IEM forecast->settlement pairs
 * (#1871, part 1). Replaces the hand-anchored constants in kalshi-weather-edge.js with
 * numbers MEASURED against reality — the one synthetic part of an otherwise-grounded model.
 *
 * DATA SOURCES (Iowa Environmental Mesonet — corrected endpoints; the research note's
 * `api/1/mos.json` 404'd, the real backends are under /cgi-bin/request/):
 *   - Forecast high: NBS (NBM) MOS, /cgi-bin/request/mos.py?station=KNYC&model=NBS&...&format=csv
 *       daily forecast high = max hourly `tmp` over the target LOCAL day.
 *   - Settled high:  ASOS hourly, /cgi-bin/request/asos.py?station=NYC&network=NY_ASOS&data=tmpf&...
 *       settled high = max hourly `tmpf` over the LOCAL day. (Proxy for the NWS CLI daily
 *       max KXHIGHNY settles on; they can differ by rounding/siting — documented caveat.)
 *
 * MODEL fit (matches kalshi-weather-edge.calibratedMean / sigmaForLead / CEILING_TABLE):
 *   settled ≈ forecast − coolBias − regressionK·max(0, forecast − normal)
 *   → OLS of residual (settled−forecast) on positive anomaly gives coolBias, regressionK.
 *   → residual std about the calibrated mean, grouped by lead, gives sigmaNowcast/Base/PerLead.
 *   → empirical P(settled ≥ 100 | forecast bin) gives the ceiling table (tail buckets only,
 *     and only where there is real support — otherwise the default entry is KEPT).
 *
 * The FIT functions are pure + unit-tested (test/fit-weather-oracle-params.test.js). Only
 * main() touches the network. Output: data/kalshi/weather-oracle-params.json, consumed by
 * kalshi-weather-edge.loadParams() with per-field fallback.
 *
 * Run (on a box with network egress — the sandbox Bash has none):
 *   node scripts/fit-weather-oracle-params.js --years 2019,2020,2021,2022,2023,2024,2025 --months 6,7,8
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_PATH = path.resolve(__dirname, "../data/kalshi/weather-oracle-params.json");

// Normals mirror kalshi-weather-edge.NORMAL_HIGH_F for the anomaly term (extended flat = 84).
const NORMAL_HIGH_F = {
  "6-25": 82.5, "6-26": 82.7, "6-27": 82.9, "6-28": 83.2, "6-29": 83.4,
  "6-30": 83.6, "7-1": 83.8, "7-2": 83.9, "7-3": 84.1, "7-4": 84.3, "7-5": 84.4,
};
const DEFAULT_NORMAL = 84.0;
const normalFor = (mmdd) => (NORMAL_HIGH_F[mmdd] == null ? DEFAULT_NORMAL : NORMAL_HIGH_F[mmdd]);

/** Build a normalFor(mmdd) for a DIFFERENT station from its own normals table + fallback —
 *  the KNYC table above must never silently apply to another station (#2217 KLGA fit). */
function makeNormalFor(normals = {}, defaultNormal = DEFAULT_NORMAL) {
  return (mmdd) => (normals[mmdd] == null ? defaultNormal : normals[mmdd]);
}

// CSV/day/MOS parsing lives in the serving lib (kalshi-mos) so fit == serve BY CONSTRUCTION —
// the fit and the live deck use one identical forecast-high definition.
const { parseCsv, localDayOf, mosForecastHighs } = require("../lib/kalshi-mos");

/** ASOS hourly tmpf rows -> {localDayKey -> settledHigh}. Accepts columns station,valid,tmpf.
 *  `roundF: true` rounds the daily max to the nearest whole °F — the ForecastEx U-series
 *  settlement definition (Weather Underground "High Temp" = round(max METAR tmpf); measured
 *  14/14 vs venue settlement flips, Jun 2026, docs/research/2026-07-10-forecastex-uhlga-*). */
function asosDailyHighs(rows, { roundF = false } = {}) {
  const byDay = new Map();
  for (const r of rows) {
    const t = parseFloat(r.tmpf);
    if (!Number.isFinite(t)) continue;
    const day = localDayOf(r.valid);
    if (!day) continue;
    const cur = byDay.get(day.key);
    if (cur == null || t > cur.high) byDay.set(day.key, { day, high: t });
  }
  if (roundF) for (const rec of byDay.values()) rec.high = Math.round(rec.high);
  return byDay;
}

/** NWS CLI JSON rows -> {localDayKey -> {day, high}}. The AUTHORITATIVE KXHIGHNY settlement
 *  source (NWS Daily Climatological Report daily max), not an ASOS proxy. CLI `valid` is
 *  already the local calendar day; `results` = [{valid:"YYYY-MM-DD", high:Int|"M"}]. */
function cliSettledHighs(results) {
  const byDay = new Map();
  for (const r of results || []) {
    const high = Number(r.high);
    if (!Number.isFinite(high)) continue;               // "M"/missing -> skip
    const m = String(r.valid || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const y = +m[1], mo = +m[2], day = +m[3];
    byDay.set(`${y}-${mo}-${day}`, { day: { key: `${y}-${mo}-${day}`, mmdd: `${mo}-${day}`, y, m: mo, day }, high });
  }
  return byDay;
}

/** Join forecasts with settled highs into {forecast, settled, lead, mmdd, anomaly, posAnom}.
 *  `normalFor` is injectable so a non-KNYC station pairs against ITS OWN normals. */
function pairData(byRun, settledByDay, { months = [6, 7, 8], normalFor: nf = normalFor } = {}) {
  const pairs = [];
  for (const { run, days } of byRun.values()) {
    for (const { tgt, high: forecast } of days.values()) {
      if (!months.includes(tgt.m)) continue;
      const settledRec = settledByDay.get(tgt.key);
      if (!settledRec) continue;
      const settled = settledRec.high;
      const lead = Math.round((Date.UTC(tgt.y, tgt.m - 1, tgt.day) - Date.UTC(run.y, run.m - 1, run.day)) / 86400000);
      if (lead < 0 || lead > 7) continue;
      const normal = nf(tgt.mmdd);
      const anomaly = forecast - normal;
      pairs.push({ forecast, settled, lead, mmdd: tgt.mmdd, anomaly, posAnom: Math.max(0, anomaly) });
    }
  }
  return pairs;
}

// ── fitting (pure) ─────────────────────────────────────────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};

/** OLS of residual (settled−forecast) on positive anomaly → coolBias, regressionK. */
function fitBiasRegression(pairs) {
  const x = pairs.map((p) => p.posAnom);
  const r = pairs.map((p) => p.settled - p.forecast);
  const n = pairs.length;
  const mx = mean(x), mr = mean(r);
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (r[i] - mr); varx += (x[i] - mx) ** 2; }
  const b = varx > 1e-9 ? cov / varx : 0;      // slope = −regressionK
  const a = mr - b * mx;                         // intercept = −coolBias
  return {
    coolBiasF: Math.round(-a * 1000) / 1000,
    regressionK: Math.round(Math.max(0, -b) * 10000) / 10000, // K >= 0 (anomalies verify LESS extreme)
    n,
  };
}

/** Residual std about the calibrated mean, grouped by lead → sigmaNowcast/Base/PerLead. */
function fitSigmaByLead(pairs, { coolBiasF, regressionK }, { minPerLead = 8 } = {}) {
  const resid = (p) => p.settled - (p.forecast - coolBiasF - regressionK * p.posAnom);
  const byLead = new Map();
  for (const p of pairs) {
    if (!byLead.has(p.lead)) byLead.set(p.lead, []);
    byLead.get(p.lead).push(resid(p));
  }
  const stdAt = (lead) => {
    const g = byLead.get(lead);
    return g && g.length >= minPerLead ? std(g) : null;
  };
  const nowcast = stdAt(0);
  const base = stdAt(1);
  // Slope of per-lead std on (lead−1) for lead>=1 with support.
  const pts = [];
  for (const [lead, g] of byLead) {
    if (lead >= 1 && g.length >= minPerLead) { const s = std(g); if (s != null) pts.push([lead - 1, s]); }
  }
  let perLead = null;
  if (pts.length >= 2) {
    const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
    let cov = 0, vx = 0;
    for (const [xx, yy] of pts) { cov += (xx - mx) * (yy - my); vx += (xx - mx) ** 2; }
    if (vx > 1e-9) perLead = cov / vx;
  }
  const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    sigmaNowcastF: r3(nowcast),
    sigmaBaseF: r3(base),
    sigmaPerLeadF: perLead == null ? null : Math.round(Math.max(0, perLead) * 1000) / 1000,
    perLeadSupport: [...byLead.entries()].map(([l, g]) => [l, g.length]).sort((a, b) => a[0] - b[0]),
  };
}

/** Empirical P(settled ≥ 100 | forecast in [f-0.5, f+0.5]) for f in tempsF. Only bins with
 *  ≥ minSupport samples are returned; the caller keeps the default for unsupported bins. */
function fitCeiling(pairs, { tempsF = [99, 100, 101, 102, 103, 104], minSupport = 12 } = {}) {
  const table = [];
  for (const f of tempsF) {
    const inBin = pairs.filter((p) => Math.abs(p.forecast - f) <= 0.5);
    if (inBin.length < minSupport) continue;
    const p100 = inBin.filter((p) => p.settled >= 100).length / inBin.length;
    table.push([f, Math.round(p100 * 1000) / 1000, inBin.length]);
  }
  return table; // [[forecastF, pGe100, support], ...]
}

/** Combine into the params object consumed by kalshi-weather-edge.loadParams(). */
function fitParams(pairs, opts = {}) {
  const bias = fitBiasRegression(pairs);
  const sig = fitSigmaByLead(pairs, bias, opts);
  const ceilRaw = fitCeiling(pairs, opts);
  const out = { coolBiasF: bias.coolBiasF, regressionK: bias.regressionK, n: pairs.length };
  if (sig.sigmaNowcastF != null) out.sigmaNowcastF = sig.sigmaNowcastF;
  if (sig.sigmaBaseF != null) out.sigmaBaseF = sig.sigmaBaseF;
  if (sig.sigmaPerLeadF != null) out.sigmaPerLeadF = sig.sigmaPerLeadF;
  if (ceilRaw.length >= 2) out.ceilingTable = ceilRaw.map(([f, p]) => [f, p]);
  out.diagnostics = { perLeadSupport: sig.perLeadSupport, ceilingSupport: ceilRaw };
  return out;
}

module.exports = {
  parseCsv, localDayOf, mosForecastHighs, asosDailyHighs, cliSettledHighs, pairData,
  fitBiasRegression, fitSigmaByLead, fitCeiling, fitParams, normalFor, makeNormalFor,
};

// ── main (network — run where egress exists) ───────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

async function main() {
  const years = arg("years", "2021,2022,2023,2024,2025").split(",").map((s) => parseInt(s, 10));
  const months = arg("months", "6,7,8").split(",").map((s) => parseInt(s, 10));
  const mosStation = arg("mos-station", "KNYC");
  const asosStation = arg("asos-station", "NYC");
  const asosNetwork = arg("asos-network", "NY_ASOS");

  let allPairs = [];
  for (const y of years) {
    const sts = `${y}-06-01T00:00Z`, ets = `${y}-09-01T00:00Z`;
    const mosUrl = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${mosStation}&model=NBS&sts=${sts}&ets=${ets}&format=csv`;
    const asosUrl = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${asosStation}&network=${asosNetwork}&data=tmpf&sts=${sts}&ets=${ets}&tz=Etc/UTC&format=onlycomma&missing=empty`;
    process.stdout.write(`[fit] ${y}: fetching MOS + ASOS…\n`);
    const [mosCsv, asosCsv] = await Promise.all([get(mosUrl), get(asosUrl)]);
    const byRun = mosForecastHighs(parseCsv(mosCsv));
    const settled = asosDailyHighs(parseCsv(asosCsv));
    const pairs = pairData(byRun, settled, { months });
    process.stdout.write(`[fit] ${y}: ${pairs.length} paired forecast/settlement rows\n`);
    allPairs = allPairs.concat(pairs);
  }

  if (allPairs.length < 100) {
    process.stderr.write(`[fit] only ${allPairs.length} pairs — too few to trust a fit (want >=100). Not writing.\n`);
    process.exit(1);
  }

  const fitted = fitParams(allPairs);
  fitted.fittedAt = new Date().toISOString().slice(0, 10);
  fitted.source = "IEM NBS MOS (forecast) + NY_ASOS tmpf (settled), summer";
  fitted.years = years; fitted.months = months;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(fitted, null, 2) + "\n");
  process.stdout.write(`[fit] wrote ${OUT_PATH}\n${JSON.stringify(fitted, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`[fit] ERROR: ${e.message}\n`); process.exit(1); });
}
