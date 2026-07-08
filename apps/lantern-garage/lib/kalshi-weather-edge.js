"use strict";

/**
 * Σ₀ weather-edge model — JS port of experiments/kalshi_weather_edge.py.
 *
 * Reason+Verify stage of the Convergence Core applied to a weather Task; NOT a new
 * subsystem. Kalshi KXHIGHNY settles on the NWS Daily Climatological Report for
 * Central Park (KNYC) — prediction target and settlement source are the SAME external
 * measurement, so the observation-channel-poisoning gap (ANTI-COLLAPSE G1) is closed
 * by construction.
 *
 * The ONE defensible edge is the >=100 F CEILING: Central Park has not reached 100 F
 * since 2012-07-18 (the 2019/2022/2025 heat waves all stalled at 99). On an extreme
 * forecast the market over-prices ">=100"; we FADE it. Routine days are efficient and
 * the gate returns nothing. An edge is reported ONLY if it survives the whole
 * calibration band (sigma + downshift uncertainty) net of Kalshi fees — a point
 * estimate that flips sign across the band is noise, not signal.
 *
 * Pure + deterministic + no network at runtime (a one-time local params-file read at
 * module init — no network). See the Python module + research note
 * docs/research/2026-06-30-sigma0-weather-oracle-kalshi-edge.md for provenance.
 *
 * CALIBRATION CONSTANTS: the distribution parameters below are DEFAULTS (the original
 * hand-anchored estimates). When data/kalshi/weather-oracle-params.json exists — written by
 * scripts/fit-weather-oracle-params.js from IEM forecast->settlement pairs (#1871) — each
 * fitted field overrides its default. Per-field validation: a missing/non-finite/mis-shaped
 * field silently keeps the default, so a bad params file can never break the oracle. With no
 * file present (the repo default), behavior is byte-identical to the original constants.
 */

const fs = require("fs");
const path = require("path");

const PARAMS_PATH = path.resolve(__dirname, "../../../data/kalshi/weather-oracle-params.json");

// ── measured climatological normals (NCEI 1991-2020 — genuinely fixed, not fit) ──
const NORMAL_HIGH_F = {
  "6-25": 82.5, "6-26": 82.7, "6-27": 82.9, "6-28": 83.2, "6-29": 83.4,
  "6-30": 83.6, "7-1": 83.8, "7-2": 83.9, "7-3": 84.1, "7-4": 84.3, "7-5": 84.4,
};
const DEFAULT_SUMMER_NORMAL_F = 84.0;

// Defaults = the original hand-anchored estimates. fit-weather-oracle-params.js overrides.
const DEFAULT_PARAMS = {
  coolBiasF: 1.2,        // Central-Park sensor runs cool vs the gridded forecast
  regressionK: 0.06,     // large positive anomalies verify less extreme
  sigmaBaseF: 2.4,       // day-ahead summer max-temp forecast sigma
  sigmaPerLeadF: 0.5,    // error spread grows with lead time
  sigmaNowcastF: 1.5,    // same-day high: much of the heating already observed
  meanUncF: 0.8,         // +/- downshift uncertainty (shrinks once IEM measures it)
  sigmaLo: 0.6, sigmaHi: 1.30,  // band multipliers; 0.6*2.4=1.44F floor for a tight market
  // P(actual KNYC high >= 100 F | NWS forecast high), from the >=100 record + the
  // 2013-2025 near-miss streak (many 99 F, zero 100 F). Interpolated.
  ceilingTable: [
    [99.0, 0.03], [100.0, 0.08], [101.0, 0.13],
    [102.0, 0.19], [103.0, 0.27], [104.0, 0.38],
  ],
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
function isCeilingTable(t) {
  return Array.isArray(t) && t.length >= 2 &&
    t.every((r) => Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]) && r[1] >= 0 && r[1] <= 1);
}

/** Load fitted params, overriding each DEFAULT field only when the file supplies a valid
 *  value. Any read/parse error, or an invalid field, falls back silently to the default. */
function loadParams(file = PARAMS_PATH) {
  const p = { ...DEFAULT_PARAMS };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { ...p, _source: "defaults" }; }
  if (!raw || typeof raw !== "object") return { ...p, _source: "defaults" };
  for (const k of ["coolBiasF", "regressionK", "sigmaBaseF", "sigmaPerLeadF", "sigmaNowcastF", "meanUncF", "sigmaLo", "sigmaHi"]) {
    if (isNum(raw[k])) p[k] = raw[k];
  }
  if (isCeilingTable(raw.ceilingTable)) p.ceilingTable = raw.ceilingTable;
  p._source = raw.fittedAt ? `fitted ${raw.fittedAt} (n=${raw.n ?? "?"})` : "params file";
  return p;
}

const PARAMS = loadParams();
const CEILING_TABLE = PARAMS.ceilingTable; // exported for callers that inspect the live ceiling

// ── math (no deps) ────────────────────────────────────────────────────────────
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x0 <= x && x <= x1) return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
  }
  return table[table.length - 1][1];
}

function normalHigh(month, day) {
  const v = NORMAL_HIGH_F[`${month}-${day}`];
  return v == null ? DEFAULT_SUMMER_NORMAL_F : v;
}

function calibratedMean(forecastHigh, month, day, P = PARAMS) {
  const anomaly = forecastHigh - normalHigh(month, day);
  return forecastHigh - P.coolBiasF - P.regressionK * Math.max(0, anomaly);
}

function sigmaForLead(leadDays, P = PARAMS) {
  if (leadDays <= 0) return P.sigmaNowcastF;
  return P.sigmaBaseF + P.sigmaPerLeadF * (leadDays - 1);
}

function bucketJustBelow100(ladder) {
  let best = null, bestHi = -999;
  for (const [lbl, , hi] of ladder) {
    if (hi != null && hi < 100 && hi > bestHi) { best = lbl; bestHi = hi; }
  }
  return best;
}

/** P(high in bucket) for an explicit (mean, sigma), with the >=100 F ceiling enforced. */
function distribution(mean, sigma, ladder, forecastHigh, P = PARAMS) {
  const band = (lo, hi) => {
    const plo = lo != null ? normCdf(((lo - 0.5) - mean) / sigma) : 0;
    const phi = hi != null ? normCdf(((hi + 0.5) - mean) / sigma) : 1;
    return Math.max(0, phi - plo);
  };
  const dist = {};
  for (const [lbl, lo, hi] of ladder) dist[lbl] = band(lo, hi);

  const ceiling = interp(P.ceilingTable, forecastHigh);
  const above = ladder.filter(([, lo]) => lo != null && lo >= 100).map(([lbl]) => lbl);
  const rawAbove = above.reduce((s, l) => s + dist[l], 0);
  if (above.length && rawAbove > ceiling) {
    const excess = rawAbove - ceiling;
    const scale = rawAbove > 0 ? ceiling / rawAbove : 0;
    for (const l of above) dist[l] *= scale;
    const sink = bucketJustBelow100(ladder);
    if (sink) dist[sink] += excess;
  }
  const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
  const out = {};
  for (const k of Object.keys(dist)) out[k] = dist[k] / total;
  return out;
}

function calibratedDistribution(forecastHigh, leadDays, ladder, month = 7, day = 1, P = PARAMS) {
  return distribution(calibratedMean(forecastHigh, month, day, P), sigmaForLead(leadDays, P), ladder, forecastHigh, P);
}

function calibrationBand(forecastHigh, leadDays, month, day, P = PARAMS) {
  const m = calibratedMean(forecastHigh, month, day, P), s = sigmaForLead(leadDays, P);
  const out = [[m, s]];
  for (const dm of [-P.meanUncF, 0, P.meanUncF]) {
    for (const fs of [P.sigmaLo, P.sigmaHi]) out.push([m + dm, s * fs]);
  }
  return out;
}

// ── Verify: robust edge vs market, net of Kalshi fees ─────────────────────────
function kalshiFeeCents(price) { return Math.max(1, Math.ceil(7 * price * (1 - price))); }

function bestSideNet(fair, ask) {
  const fairC = 100 * fair;
  const yes = (fairC - 100 * ask) - kalshiFeeCents(ask);
  const noAsk = 1 - ask;
  const no = ((100 - fairC) - 100 * noAsk) - kalshiFeeCents(noAsk);
  return yes >= no ? ["yes", yes] : ["no", no];
}

/**
 * Per-bucket edge that must SURVIVE THE WHOLE calibration band to count. Actionable
 * only if the side is identical across all band scenarios AND the worst-case net edge
 * still clears fees + minEdgeCents. worst_c is what you can rely on; best_c the corner.
 */
function robustEdgeReport(forecastHigh, leadDays, ladder, marketAsk, month = 7, day = 1, minEdgeCents = 5, P = PARAMS) {
  const scen = calibrationBand(forecastHigh, leadDays, month, day, P);
  const dists = scen.map(([m, s]) => distribution(m, s, ladder, forecastHigh, P));
  const nominal = dists[0];
  const rows = [], actionable = [];
  for (const [lbl] of ladder) {
    const a = marketAsk[lbl];
    if (a == null) continue;
    const outcomes = dists.map((d) => bestSideNet(d[lbl], a));
    const sides = new Set(outcomes.map((o) => o[0]));
    const nets = outcomes.map((o) => o[1]);
    const consistent = sides.size === 1;
    const worst = Math.min(...nets), best = Math.max(...nets);
    const robust = consistent && worst >= minEdgeCents;
    const row = {
      bucket: lbl, fair_pct: Math.round(1000 * nominal[lbl]) / 10,
      ask_c: Math.round(1000 * a) / 10, side: consistent ? outcomes[0][0] : "mixed",
      worst_c: Math.round(10 * worst) / 10, best_c: Math.round(10 * best) / 10,
      fair: nominal[lbl], robust,
    };
    rows.push(row);
    if (robust) actionable.push(row);
  }
  rows.sort((x, y) => y.worst_c - x.worst_c);
  const verdict = actionable.length
    ? "robust: " + actionable.map((r) => `${r.side.toUpperCase()} ${r.bucket} (>=${r.worst_c >= 0 ? "+" : ""}${Math.round(r.worst_c)}c)`).join(", ")
    : "no certified edge";
  // dist (nominal, keyed by ladder label) + ladder are surfaced so the paper ledger can
  // stamp the predictive distribution at open — the join the distribution verifier needs
  // to accrue graded outcomes (kalshi-weather-verify gradedRecords, #2218).
  return { rows, actionable, verdict, dist: nominal, ladder };
}

// ── bucket subtitle parser: "100° or above"->[100,null], "94° to 95°"->[94,95] ──
function parseBand(sub) {
  const s = String(sub || "").replace(/°/g, " ").trim();
  let m = s.match(/(\d+)\s*(?:or above|and above|\+|or more)/i);
  if (m) return [parseInt(m[1], 10), null];
  m = s.match(/(\d+)\s*or below/i);
  if (m) return [null, parseInt(m[1], 10)];
  m = s.match(/(\d+)\s*(?:to|-|–)\s*(\d+)/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  return null;
}

// ── self-test: mirrors the Python selfcheck's ground-truth assertions ─────────
function selfTest() {
  const fails = [];
  const JUL1 = [["<=91", null, 91], ["92-93", 92, 93], ["94-95", 94, 95],
                ["96-97", 96, 97], ["98-99", 98, 99], [">=100", 100, null]];
  const HOT = [["<=95", null, 95], ["96-97", 96, 97], ["98-99", 98, 99],
               ["100-101", 100, 101], [">=102", 102, null]];
  const JUL1_ASK = { "<=91": .09, "92-93": .27, "94-95": .45, "96-97": .20, "98-99": .06, ">=100": .01 };
  const HOT_ASK = { "<=95": .05, "96-97": .12, "98-99": .18, "100-101": .40, ">=102": .18 };

  // Test the MODEL LOGIC against the ORIGINAL hand-anchored constants (DEFAULT_PARAMS),
  // independent of whatever fitted params are deployed — otherwise a promoted params file
  // (which legitimately shifts behavior) would break this smoke test. Deployed-params
  // behavior is validated out-of-sample by scripts/validate-weather-oracle-fit.js instead.
  const D = DEFAULT_PARAMS;

  const d1 = calibratedDistribution(96, 1, JUL1, 7, 1, D);
  if (!(d1[">=100"] < 0.031)) fails.push(`Jul1 P(>=100)=${d1[">=100"].toFixed(3)} not <0.031`);
  const modal1 = Object.keys(d1).reduce((a, b) => d1[a] >= d1[b] ? a : b);
  if (modal1 !== "94-95") fails.push(`Jul1 modal=${modal1} not 94-95`);

  const r1 = robustEdgeReport(96, 1, JUL1, JUL1_ASK, 7, 1, 5, D);
  if (r1.actionable.length) fails.push(`Jul1 should be no-edge, got ${r1.verdict}`);

  const d3 = calibratedDistribution(102, 3, HOT, 7, 1, D);
  const p100 = d3["100-101"] + d3[">=102"];
  if (!(p100 > 0.05 && p100 < 0.20)) fails.push(`Jul3 P(>=100)=${p100.toFixed(3)} outside (0.05,0.20)`);

  const r3 = robustEdgeReport(102, 3, HOT, HOT_ASK, 7, 1, 5, D);
  const fade = r3.actionable.find((r) => r.bucket === "100-101");
  if (!(fade && fade.side === "no" && fade.worst_c > 15)) fails.push(`hot-day fade not robust: ${JSON.stringify(fade)}`);

  if (kalshiFeeCents(0.40) !== 2 || kalshiFeeCents(0.09) !== 1) fails.push("fee formula off");

  // Params MUST flow through: a warmer coolBias raises the calibrated mean.
  const warm = { ...D, coolBiasF: -1.5 };
  if (!(calibratedMean(96, 7, 1, warm) > calibratedMean(96, 7, 1, D) + 2)) {
    fails.push("params override not threaded into calibratedMean");
  }

  return { ok: fails.length === 0, fails };
}

module.exports = {
  calibratedMean, sigmaForLead, calibratedDistribution, distribution,
  robustEdgeReport, kalshiFeeCents, parseBand, selfTest,
  CEILING_TABLE, loadParams, DEFAULT_PARAMS, paramsSource: () => PARAMS._source,
};

if (require.main === module) {
  const r = selfTest();
  process.stdout.write(`Σ₀ weather-edge self-test: ${r.ok ? "PASS" : "FAIL"}\n`);
  process.stdout.write(`params: ${PARAMS._source}\n`);
  if (!r.ok) { for (const f of r.fails) process.stdout.write("  - " + f + "\n"); process.exit(1); }
}
