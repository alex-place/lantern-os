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
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const F = require("./fit-weather-oracle-params");
const verify = require("../apps/lantern-garage/lib/kalshi-weather-verify");
const oracle = require("../apps/lantern-garage/lib/kalshi-weather-edge");

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
 *  under a param set, mirroring kalshi-weather-edge (calibratedMean/sigmaForLead + ceiling). */
function forwardProbs(forecast, lead, mmdd, params) {
  const normal = F.normalFor(mmdd);
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
function scoreParams(pairs, params) {
  const rpss = [], pits = [];
  for (const p of pairs) {
    const { probs, lo } = forwardProbs(p.forecast, p.lead, p.mmdd, params);
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
      if (e.code === 429 && i < tries - 1) { await sleep(3000 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function fetchYear(y, { mosStation = "KNYC", asosStation = "NYC", asosNetwork = "NY_ASOS" } = {}) {
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
  const asos = F.asosDailyHighs(F.parseCsv(asosCsv));
  return {
    cliPairs: F.pairData(byRun, cli, { months: [6, 7, 8] }),
    asosPairs: F.pairData(byRun, asos, { months: [6, 7, 8] }),
    cli, asos,
  };
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

async function main() {
  const train = arg("train", "2021,2022,2023").split(",").map(Number);
  const test = arg("test", "2024,2025").split(",").map(Number);
  const promote = process.argv.includes("--promote");
  const round = (v, k = 4) => (v == null ? null : Math.round(v * 10 ** k) / 10 ** k);

  const years = [...new Set([...train, ...test])];
  const data = {};
  for (const y of years) { process.stdout.write(`[val] fetching ${y}…\n`); data[y] = await fetchYear(y); }

  // 1. CLI vs ASOS on shared days — explain the sign flip.
  let dSum = 0, dN = 0;
  for (const y of years) {
    for (const [key, rec] of data[y].cli) {
      const a = data[y].asos.get(key);
      if (a) { dSum += a.high - rec.high; dN++; }
    }
  }
  const asosMinusCli = dN ? dSum / dN : null;

  const trainPairs = train.flatMap((y) => data[y].cliPairs);
  const testPairs = test.flatMap((y) => data[y].cliPairs);
  process.stdout.write(`[val] CLI pairs: train=${trainPairs.length} test=${testPairs.length}\n`);
  process.stdout.write(`[val] ASOS max − CLI high mean = ${round(asosMinusCli, 2)}°F over n=${dN} days\n`);

  // 2. Fit on train (CLI).
  const fitted = merge(F.fitParams(trainPairs));
  const defaults = oracle.DEFAULT_PARAMS;

  // 3. OOS score: fitted vs default on held-out test years.
  const sD = scoreParams(testPairs, defaults);
  const sF = scoreParams(testPairs, fitted);
  const rpsGain = sD.meanRPS != null && sF.meanRPS != null ? (sD.meanRPS - sF.meanRPS) / sD.meanRPS : null;

  const report = {
    train, test, asosMinusCli: round(asosMinusCli, 2),
    fittedOnCli: { coolBiasF: fitted.coolBiasF, regressionK: fitted.regressionK, sigmaBaseF: fitted.sigmaBaseF, sigmaNowcastF: fitted.sigmaNowcastF, sigmaPerLeadF: fitted.sigmaPerLeadF },
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
    const full = F.fitParams([...trainPairs, ...testPairs]); // fit on ALL CLI pairs for the live file
    full.fittedAt = new Date().toISOString().slice(0, 10);
    full.source = "IEM NBS MOS (forecast) + NWS CLI (settled, authoritative), summer";
    full.validation = report.oos;
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(full, null, 2) + "\n");
    process.stdout.write(`[val] PROMOTED -> wrote ${OUT_PATH}\n`);
  } else if (promote) {
    process.stdout.write(`[val] NOT promoted (fitted did not beat default OOS). Defaults stay.\n`);
  }
  return beatsDefault;
}

if (require.main === module) {
  main().then((ok) => process.exit(ok ? 0 : 2)).catch((e) => { process.stderr.write(`[val] ERROR: ${e.message}\n${e.stack}\n`); process.exit(1); });
}

module.exports = { forwardProbs, scoreParams };
