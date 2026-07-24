"use strict";

/**
 * Promotion validation for the fitted weather-oracle constants (#1871).
 *
 * The first fit (fit-weather-oracle-params.js) used ASOS max-of-hourly as the settled leg and
 * found the coolBias SIGN flipped. That could be a real signal or an artifact of ASOS-max vs
 * the true settlement. This script decides, with evidence:
 *
 *   1. Pull the settled leg from the AUTHORITATIVE NWS CLI (what KXHIGHNY settles on), and
 *      quantify CLI-vs-ASOS so the sign flip is explained, not guessed.
 *   2. Re-fit against CLI.
 *   3. OUT-OF-SAMPLE test: fit on train years, score the resulting predictive distribution on
 *      held-out years with the distribution-level Verify (kalshi-weather-verify: RPS/PIT) —
 *      fitted vs the current DEFAULT constants.
 *   4. PROMOTE (write data/kalshi/weather-oracle-params.json) ONLY if fitted beats default OOS.
 *
 * The forecast leg stays NBS (NBM) MOS: the gridded NWS forecast the deck consumes is NOT
 * archived historically, and NBM is what that gridded forecast is largely built from — the
 * best archivable proxy. This limit is stated honestly; it does not affect the settled leg,
 * which is now the true source.
 *
 * Network runs where egress exists. Run:
 *   node scripts/validate-weather-oracle-fit.js --train 2021,2022,2023 --test 2024,2025 [--promote]
 *
 * STATION-GENERIC (#2217): every leg is parameterizable, so the SAME gated pipeline fits any
 * station. The ForecastEx U-series NYC contract (UHLGA) settles on Weather Underground's
 * daily high — measured to equal round(max METAR tmpf) for LGA, 14/14 days vs the venue's
 * published settlement flips (Jun 2026) — so its settled leg is `--settled asos` (rounded),
 * NOT the NWS CLI (CLI disagreed 6/13 days, up to 4°F warmer). KLGA fit:
 *   node scripts/validate-weather-oracle-fit.js --mos-station KLGA --asos-station LGA \
 *     --settled asos --normals-cli-year 2025 --train 2021,2022,2023 --test 2024,2025 \
 *     --out data/kalshi/weather-oracle-params-klga.json --promote
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const F = require("./fit-weather-oracle-params");
const verify = require("../lib/kalshi-weather-verify");
const oracle = require("../lib/kalshi-weather-edge");

const OUT_PATH = path.resolve(__dirname, "../data/kalshi/weather-oracle-params.json");
const BUCKET_LO = 70, BUCKET_HI = 110; // integer °F buckets for scoring

// tiny normCdf (same A&S approx as the oracle) + ceiling interp — kept local so the analysis
// is self-contained; it is a forward model, not a second copy of production logic.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x0 <= x && x <= x1) return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
  }
  return table[table.length - 1][1];
}

/** Predictive prob vector over integer buckets BUCKET_LO..BUCKET_HI for one (forecast, lead)
 *  under a param set, mirroring kalshi-weather-edge (calibratedMean/sigmaForLead + ceiling).
 *  `normalFor` is injectable so a non-KNYC station scores against ITS OWN normals. */
function forwardProbs(forecast, lead, mmdd, params, normalFor = F.normalFor) {
  const normal = normalFor(mmdd);
  const mean = forecast - params.coolBiasF - params.regressionK * Math.max(0, forecast - normal);
  const sigma = lead <= 0 ? params.sigmaNowcastF : params.sigmaBaseF + params.sigmaPerLeadF * (lead - 1);
  const buckets = [];
  for (let t = BUCKET_LO; t <= BUCKET_HI; t++) buckets.push(t);
  const probs = buckets.map((t) => Math.max(0, normCdf((t + 0.5 - mean) / sigma) - normCdf((t - 0.5 - mean) / sigma)));
  // ceiling cap on >=100, excess piled at 99 (mirror oracle.distribution)
  const ceiling = interp(params.ceilingTable, forecast);
  let above = 0;
  for (let i = 0; i < buckets.length; i++) if (buckets[i] >= 100) above += probs[i];
  if (above > ceiling && above > 0) {
    const scale = ceiling / above, excess = above - ceiling;
    for (let i = 0; i < buckets.length; i++) if (buckets[i] >= 100) probs[i] *= scale;
    probs[99 - BUCKET_LO] += excess;
  }
  const total = probs.reduce((s, v) => s + v, 0) || 1;
  return { probs: probs.map((p) => p / total), lo: BUCKET_LO };
}

/** Mean RPS + PIT-χ² of a param set over pairs, using kalshi-weather-verify's proper scores. */
function scoreParams(pairs, params, normalFor = F.normalFor) {
  const rpss = [], pits = [];
  for (const p of pairs) {
    const { probs, lo } = forwardProbs(p.forecast, p.lead, p.mmdd, params, normalFor);
    const obsIdx = Math.max(0, Math.min(probs.length - 1, Math.round(p.settled) - lo));
    const r = verify.rps(probs, obsIdx);
    if (r != null) rpss.push(r);
    const pv = verify.pit(probs, obsIdx);
    if (pv != null) pits.push(pv);
  }
  const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  return { n: rpss.length, meanRPS: mean(rpss), pitChi2: verify.pitUniformity(pits)?.chi2_reduced ?? null };
}

const merge = (fitted) => ({ ...oracle.DEFAULT_PARAMS, ...Object.fromEntries(Object.entries(fitted).filter(([, v]) => typeof v === "number")) , ceilingTable: fitted.ceilingTable || oracle.DEFAULT_PARAMS.ceilingTable });

// ── network ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const code = res.statusCode;
      if (code !== 200) { res.resume(); const e = new Error(`HTTP ${code}`); e.code = code; return reject(e); }
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => b += c); res.on("end", () => resolve(b));
    });
    req.setTimeout(90000, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await getOnce(url); }
    catch (e) {
      // 429 = IEM rate limit; socket hang up / reset / timeout = transient on long ASOS pulls.
      const transient = e.code === 429 || /socket hang up|ECONNRESET|timeout/i.test(e.message || "");
      if (transient && i < tries - 1) { await sleep(3000 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function fetchYear(y, { mosStation = "KNYC", asosStation = "NYC", asosNetwork = "NY_ASOS", roundAsos = false, normalFor = F.normalFor } = {}) {
  const sts = `${y}-06-01T00:00Z`, ets = `${y}-09-01T00:00Z`;
  const mosUrl = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${mosStation}&model=NBS&sts=${sts}&ets=${ets}&format=csv`;
  const asosUrl = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${asosStation}&network=${asosNetwork}&data=tmpf&sts=${sts}&ets=${ets}&tz=Etc/UTC&format=onlycomma&missing=empty`;
  const cliUrl = `https://mesonet.agron.iastate.edu/json/cli.py?station=${mosStation}&year=${y}`;
  // Sequential + spaced to stay under the IEM rate limit.
  const mosCsv = await get(mosUrl); await sleep(1500);
  const asosCsv = await get(asosUrl); await sleep(1500);
  const cliJson = await get(cliUrl); await sleep(1500);
  const byRun = F.mosForecastHighs(F.parseCsv(mosCsv));
  const cli = F.cliSettledHighs(JSON.parse(cliJson).results);
  const asos = F.asosDailyHighs(F.parseCsv(asosCsv), { roundF: roundAsos });
  return {
    cliPairs: F.pairData(byRun, cli, { months: [6, 7, 8], normalFor }),
    asosPairs: F.pairData(byRun, asos, { months: [6, 7, 8], normalFor }),
    cli, asos,
  };
}

/** Station normals from the NWS CLI itself (`high_normal` per day — NCEI 1991-2020 climatology,
 *  identical across years). Returns { normals: {"m-d": F}, defaultNormal } for makeNormalFor. */
async function fetchCliNormals(station, year) {
  const cliJson = await get(`https://mesonet.agron.iastate.edu/json/cli.py?station=${station}&year=${year}`);
  await sleep(1500);
  const normals = {};
  const summer = [];
  for (const r of JSON.parse(cliJson).results || []) {
    const n = Number(r.high_normal);
    const m = String(r.valid || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!Number.isFinite(n) || !m) continue;
    normals[`${+m[2]}-${+m[3]}`] = n;
    if ([6, 7, 8].includes(+m[2])) summer.push(n);
  }
  const defaultNormal = summer.length ? Math.round((summer.reduce((s, v) => s + v, 0) / summer.length) * 10) / 10 : null;
  return { normals, defaultNormal };
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

async function main() {
  const train = arg("train", "2021,2022,2023").split(",").map(Number);
  const test = arg("test", "2024,2025").split(",").map(Number);
  const promote = process.argv.includes("--promote");
  const mosStation = arg("mos-station", "KNYC");
  const asosStation = arg("asos-station", "NYC");
  const asosNetwork = arg("asos-network", "NY_ASOS");
  const settledLeg = arg("settled", "cli"); // cli (Kalshi/NWS-report venues) | asos (ForecastEx U-series: round(max METAR tmpf) ≡ Weather Underground)
  const outPath = path.resolve(arg("out", OUT_PATH));
  const normalsCliYear = arg("normals-cli-year", "");
  const round = (v, k = 4) => (v == null ? null : Math.round(v * 10 ** k) / 10 ** k);

  if (!["cli", "asos"].includes(settledLeg)) throw new Error(`--settled must be cli|asos, got ${settledLeg}`);

  // Station normals: default KNYC table; or derived from the station's own NWS CLI high_normal.
  let normalFor = F.normalFor;
  if (normalsCliYear) {
    process.stdout.write(`[val] fetching ${mosStation} normals from CLI ${normalsCliYear}…\n`);
    const { normals, defaultNormal } = await fetchCliNormals(mosStation, normalsCliYear);
    if (defaultNormal == null) throw new Error(`no CLI high_normal data for ${mosStation} ${normalsCliYear}`);
    normalFor = F.makeNormalFor(normals, defaultNormal);
    process.stdout.write(`[val] ${Object.keys(normals).length} daily normals, summer default ${defaultNormal}°F\n`);
  }

  const years = [...new Set([...train, ...test])];
  const data = {};
  const yearOpts = { mosStation, asosStation, asosNetwork, roundAsos: settledLeg === "asos", normalFor };
  for (const y of years) { process.stdout.write(`[val] fetching ${y}…\n`); data[y] = await fetchYear(y, yearOpts); }

  // 1. CLI vs ASOS on shared days — quantifies the settled-leg gap (for ForecastEx this is
  //    the Weather-Underground-vs-NWS-CLI settlement divergence measured on the full history).
  let dSum = 0, dN = 0;
  for (const y of years) {
    for (const [key, rec] of data[y].cli) {
      const a = data[y].asos.get(key);
      if (a) { dSum += a.high - rec.high; dN++; }
    }
  }
  const asosMinusCli = dN ? dSum / dN : null;

  const pairsKey = settledLeg === "asos" ? "asosPairs" : "cliPairs";
  const trainPairs = train.flatMap((y) => data[y][pairsKey]);
  const testPairs = test.flatMap((y) => data[y][pairsKey]);
  process.stdout.write(`[val] ${settledLeg.toUpperCase()} pairs: train=${trainPairs.length} test=${testPairs.length}\n`);
  process.stdout.write(`[val] ASOS max − CLI high mean = ${round(asosMinusCli, 2)}°F over n=${dN} days\n`);

  // 2. Fit on train.
  const fitted = merge(F.fitParams(trainPairs));
  const defaults = oracle.DEFAULT_PARAMS;

  // 3. OOS score: fitted vs default on held-out test years.
  const sD = scoreParams(testPairs, defaults, normalFor);
  const sF = scoreParams(testPairs, fitted, normalFor);
  const rpsGain = sD.meanRPS != null && sF.meanRPS != null ? (sD.meanRPS - sF.meanRPS) / sD.meanRPS : null;

  const report = {
    train, test, mosStation, settledLeg, asosMinusCli: round(asosMinusCli, 2),
    fittedParams: { coolBiasF: fitted.coolBiasF, regressionK: fitted.regressionK, sigmaBaseF: fitted.sigmaBaseF, sigmaNowcastF: fitted.sigmaNowcastF, sigmaPerLeadF: fitted.sigmaPerLeadF },
    oos: {
      default: { meanRPS: round(sD.meanRPS), pitChi2: round(sD.pitChi2, 2), n: sD.n },
      fitted: { meanRPS: round(sF.meanRPS), pitChi2: round(sF.pitChi2, 2), n: sF.n },
      rpsGainPct: round(rpsGain == null ? null : rpsGain * 100, 1),
    },
  };
  process.stdout.write(`\n[val] RESULT\n${JSON.stringify(report, null, 2)}\n`);

  const beatsDefault = sF.meanRPS != null && sD.meanRPS != null && sF.meanRPS < sD.meanRPS;
  process.stdout.write(`\n[val] fitted ${beatsDefault ? "BEATS" : "does NOT beat"} default out-of-sample ` +
    `(RPS ${round(sF.meanRPS)} vs ${round(sD.meanRPS)})\n`);

  if (promote && beatsDefault) {
    const full = F.fitParams([...trainPairs, ...testPairs]); // fit on ALL pairs for the live file
    full.fittedAt = new Date().toISOString().slice(0, 10);
    full.station = mosStation;
    full.source = settledLeg === "asos"
      ? `IEM NBS MOS (forecast, ${mosStation}) + ${asosNetwork}/${asosStation} round(max METAR tmpf) (settled — ForecastEx U-series/Weather Underground definition), summer`
      : "IEM NBS MOS (forecast) + NWS CLI (settled, authoritative), summer";
    full.validation = report.oos;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(full, null, 2) + "\n");
    process.stdout.write(`[val] PROMOTED -> wrote ${outPath}\n`);
  } else if (promote) {
    process.stdout.write(`[val] NOT promoted (fitted did not beat default OOS). Defaults stay.\n`);
  }
  return beatsDefault;
}

if (require.main === module) {
  main().then((ok) => process.exit(ok ? 0 : 2)).catch((e) => { process.stderr.write(`[val] ERROR: ${e.message}\n${e.stack}\n`); process.exit(1); });
}

module.exports = { forwardProbs, scoreParams, fetchCliNormals };
