"use strict";

/**
 * Σ₀ weather-oracle DISTRIBUTION-level Verify (#1871, part 3).
 *
 * kalshi-calibration.js (#1872) grades a single SCALAR — the model's win-probability for
 * the one bucket we sized — with a Brier score, and feeds back a global logit shift. That
 * is necessary but not sufficient: a scalar Brier cannot tell you whether the whole
 * predictive DISTRIBUTION is calibrated (sharp in the right place, honest in the tail), and
 * a global shift cannot fix a forecast-CONDITIONAL error (fine on routine days, wrong in the
 * ≥100 °F tail). This module scores the full distribution the oracle actually emits.
 *
 * Three proper-scoring diagnostics over the ORDINAL bucket ladder:
 *   - RPS  (Ranked Probability Score) — the discrete-CRPS analog for ordered categories.
 *          Rewards putting mass NEAR the truth, not just ON it. Lower is better.
 *   - PIT  (Probability Integral Transform) — where the realized bucket falls in the
 *          predicted CDF. A calibrated model ⇒ PIT ~ Uniform(0,1). A U-shaped PIT ⇒
 *          over-confident (too sharp); a hump ⇒ under-confident (too wide); a lean ⇒ bias.
 *   - Reliability / ECE on the held-bucket probability — the calibration curve #1872's
 *          scalar Brier summarizes but never exposes.
 *
 * PURE + DETERMINISTIC + no network — same contract as kalshi-weather-edge.js. Reads only
 * the paper ledger (predictions stamped at open, observed bucket at settle). DEGRADES TO A
 * HONEST NO-OP under MIN_SAMPLES: with too few settled rows there is no evidence to report a
 * calibration verdict, and it says so — the same discipline as #1872.
 *
 * External reality beats internal consistency: every number here is measured against a
 * SETTLED NWS outcome, never assumed.
 */

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const PAPER_FILE = path.join(KALSHI_DIR, "paper-positions.jsonl");

const MIN_SAMPLES = 20;            // settled distributions before a calibration verdict
const WEATHER_PREFIX = "KXHIGH";   // scope: only the weather series we actually run
const PIT_BINS = 10;

// ── ladder / distribution helpers ─────────────────────────────────────────────

/** Order a {label: prob} distribution into a probability vector following `ladder`
 *  order (ladder = [[label, lo, hi], …] low→high), renormalized defensively. */
function distVector(dist, ladder) {
  const raw = ladder.map(([lbl]) => Math.max(0, Number(dist[lbl]) || 0));
  const total = raw.reduce((s, v) => s + v, 0);
  return total > 0 ? raw.map((v) => v / total) : raw.map(() => 1 / raw.length);
}

function cdf(vec) {
  const out = [];
  let acc = 0;
  for (const p of vec) { acc += p; out.push(acc); }
  if (out.length) out[out.length - 1] = 1; // clamp fp drift
  return out;
}

/** Index of the ladder bucket whose [lo, hi] contains `high` (lo/hi may be null = open). */
function settledBucketFromHigh(ladder, high) {
  const h = Number(high);
  if (!Number.isFinite(h)) return -1;
  for (let i = 0; i < ladder.length; i++) {
    const [, lo, hi] = ladder[i];
    const okLo = lo == null || h >= lo;
    const okHi = hi == null || h <= hi;
    if (okLo && okHi) return i;
  }
  return -1;
}

// ── proper scores ─────────────────────────────────────────────────────────────

/** Ranked Probability Score for one forecast. probs = P(bucket) low→high, obsIdx = the
 *  bucket that settled. Σ_k (CDF_pred_k − CDF_obs_k)²  over K−1 boundaries, so it lives in
 *  [0, 1] and is comparable across ladders of the same K. 0 = a point mass on the truth. */
function rps(probs, obsIdx) {
  const K = probs.length;
  if (K < 2 || obsIdx < 0 || obsIdx >= K) return null;
  const F = cdf(probs);
  let s = 0;
  for (let k = 0; k < K - 1; k++) {
    const obsCdf = k >= obsIdx ? 1 : 0; // step CDF of the realized outcome
    const d = F[k] - obsCdf;
    s += d * d;
  }
  return s / (K - 1);
}

/** Randomized PIT for a discrete forecast: CDF below the observed bucket + half its mass
 *  (mid-bucket convention). Calibrated ⇒ these are Uniform(0,1). */
function pit(probs, obsIdx) {
  const K = probs.length;
  if (K < 1 || obsIdx < 0 || obsIdx >= K) return null;
  let below = 0;
  for (let k = 0; k < obsIdx; k++) below += probs[k];
  return below + 0.5 * probs[obsIdx];
}

/** Reduced χ² of a PIT sample vs Uniform over `bins`. ≈1 ⇒ uniform/calibrated; ≫1 ⇒
 *  mis-calibrated (U-shape over-confident, hump under-confident). Needs the sample size. */
function pitUniformity(pits, bins = PIT_BINS) {
  const vals = pits.filter((p) => Number.isFinite(p));
  const n = vals.length;
  if (n === 0) return null;
  const counts = new Array(bins).fill(0);
  for (const p of vals) {
    let b = Math.floor(Math.min(0.999999, Math.max(0, p)) * bins);
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  const expected = n / bins;
  let chi = 0;
  for (const c of counts) chi += (c - expected) ** 2 / expected;
  return { chi2_reduced: chi / (bins - 1), bins, n, histogram: counts };
}

/** Reliability curve + Expected Calibration Error on the held-bucket probability.
 *  pairs = [{p, outcome}] where p = P(held bucket) and outcome ∈ {0,1} did it settle in. */
function reliability(pairs, bins = 10) {
  const rows = pairs.filter((x) => Number.isFinite(x.p) && (x.outcome === 0 || x.outcome === 1));
  const n = rows.length;
  if (n === 0) return { n: 0, ece: null, curve: [] };
  const acc = Array.from({ length: bins }, () => ({ sp: 0, so: 0, c: 0 }));
  for (const { p, outcome } of rows) {
    let b = Math.floor(Math.min(0.999999, Math.max(0, p)) * bins);
    if (b >= bins) b = bins - 1;
    acc[b].sp += p; acc[b].so += outcome; acc[b].c += 1;
  }
  let ece = 0;
  const curve = [];
  for (let b = 0; b < bins; b++) {
    const { sp, so, c } = acc[b];
    if (!c) continue;
    const conf = sp / c, freq = so / c;
    ece += (c / n) * Math.abs(conf - freq);
    curve.push({ bin: b, n: c, confidence: Math.round(conf * 1000) / 1000, frequency: Math.round(freq * 1000) / 1000 });
  }
  return { n, ece, curve };
}

// ── ledger grading ────────────────────────────────────────────────────────────

/** Join open rows (carrying the stamped predictive `dist` + `ladder`) with their close
 *  rows (carrying the observed outcome) into graded distribution/outcome records. A usable
 *  record needs: a numeric `dist` over a `ladder` on the open, and an observed bucket on the
 *  close — either explicit `settledBucket`, or `settledHigh` resolved through the ladder. */
function gradedRecords(rows) {
  const openById = new Map();
  for (const r of rows) if (r && r.event === "open") openById.set(r.id, r);
  const out = [];
  for (const r of rows) {
    if (!r || r.event !== "close") continue;
    const o = openById.get(r.id);
    if (!o) continue;
    if (!String(o.ticker || "").startsWith(WEATHER_PREFIX)) continue;
    const ladder = o.ladder;
    const dist = o.dist;
    if (!Array.isArray(ladder) || !ladder.length || !dist || typeof dist !== "object") continue;

    let obsIdx = Number.isInteger(r.settledBucket) ? r.settledBucket
      : settledBucketFromHigh(ladder, r.settledHigh);
    if (obsIdx < 0 || obsIdx >= ladder.length) continue;

    const vec = distVector(dist, ladder);
    // held-bucket probability for the reliability curve: the bucket we actually sized/held,
    // matched by label; falls back to the modal bucket if the held label isn't on the ladder.
    let heldIdx = ladder.findIndex(([lbl]) => lbl === o.heldBucket);
    if (heldIdx < 0) heldIdx = vec.indexOf(Math.max(...vec));
    out.push({
      id: r.id, ticker: o.ticker, ladder, vec, obsIdx,
      rps: rps(vec, obsIdx),
      pit: pit(vec, obsIdx),
      p: vec[heldIdx],
      outcome: heldIdx === obsIdx ? 1 : 0,
    });
  }
  return out;
}

/** buildReport — the distribution-calibration verdict over graded records. Honest no-op
 *  under MIN_SAMPLES. Reference point: RPS/PIT-χ² of the climatological (flat) forecast, so
 *  a reader can see whether the oracle beats "know nothing". */
function buildReport(records) {
  const recs = records.filter((x) => x && Number.isFinite(x.rps));
  const n = recs.length;
  const active = n >= MIN_SAMPLES;
  if (n === 0) {
    return { n: 0, active: false, meanRPS: null, pit: null, reliability: null,
      report: `no settled weather distributions yet (need ${MIN_SAMPLES}) — nothing to verify` };
  }
  const meanRPS = recs.reduce((s, x) => s + x.rps, 0) / n;
  const pitStats = pitUniformity(recs.map((x) => x.pit));
  const rel = reliability(recs.map((x) => ({ p: x.p, outcome: x.outcome })));

  // Climatological baseline RPS: a flat forecast over each record's own ladder.
  const baseRPS = recs.reduce((s, x) => {
    const K = x.vec.length;
    return s + rps(new Array(K).fill(1 / K), x.obsIdx);
  }, 0) / n;
  const skill = baseRPS > 0 ? 1 - meanRPS / baseRPS : null; // RPSS: >0 beats climatology

  const report = active
    ? `n=${n} settled · RPS ${meanRPS.toFixed(4)} vs climatology ${baseRPS.toFixed(4)} ` +
      `(skill ${skill == null ? "n/a" : (skill >= 0 ? "+" : "") + (skill * 100).toFixed(1) + "%"}) · ` +
      `PIT χ²ᵣ ${pitStats.chi2_reduced.toFixed(2)} ` +
      `(${pitStats.chi2_reduced < 1.5 ? "calibrated" : pitStats.chi2_reduced < 3 ? "mild mis-calibration" : "mis-calibrated"}) · ` +
      `ECE ${rel.ece == null ? "n/a" : rel.ece.toFixed(3)}`
    : `warming: n=${n} settled distributions (need ${MIN_SAMPLES}) — verdict withheld`;

  return {
    n, active, meanRPS, climatologyRPS: baseRPS, rpsSkill: skill,
    pit: pitStats, reliability: rel, minSamples: MIN_SAMPLES, report,
  };
}

/** Public entry: grade the live paper ledger. */
function verifyWeatherOracle({ file = PAPER_FILE } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { rows = []; }
  return buildReport(gradedRecords(rows));
}

// ── self-test (deterministic; synthetic ledgers, no disk, no RNG) ──────────────

function selfTest() {
  const fails = [];
  const LAD = [["a", null, 91], ["b", 92, 93], ["c", 94, 95], ["d", 96, 97], ["e", 98, 99], ["f", 100, null]];

  // RPS: point mass on the truth = 0; mass one bucket away > 0 but < mass three away.
  const onTruth = [0, 0, 1, 0, 0, 0];
  if (rps(onTruth, 2) !== 0) fails.push(`rps point-mass-on-truth should be 0, got ${rps(onTruth, 2)}`);
  const near = rps([0, 1, 0, 0, 0, 0], 2), far = rps([1, 0, 0, 0, 0, 0], 2);
  if (!(near > 0 && near < far)) fails.push(`rps should reward nearness: near=${near} far=${far}`);

  // settledBucketFromHigh maps a high into the right bucket (open-ended tails included).
  if (settledBucketFromHigh(LAD, 95) !== 2) fails.push("settledBucketFromHigh(95) should be 2");
  if (settledBucketFromHigh(LAD, 103) !== 5) fails.push("settledBucketFromHigh(103) should be 5 (open top)");
  if (settledBucketFromHigh(LAD, 80) !== 0) fails.push("settledBucketFromHigh(80) should be 0 (open bottom)");

  // A well-calibrated ledger: sharp forecast on bucket c, truth lands on c → low RPS,
  // beats climatology, PIT centered. Build 24 such settled records deterministically.
  const good = [];
  for (let i = 0; i < 24; i++) {
    // rotate the truth across buckets, each time with mass concentrated on the truth ±1
    const t = i % LAD.length;
    const dist = {};
    LAD.forEach(([lbl], k) => { dist[lbl] = k === t ? 0.6 : Math.abs(k - t) === 1 ? 0.2 : 0.0; });
    good.push({ event: "open", id: `g${i}`, ticker: "KXHIGHNY-x", ladder: LAD, dist, heldBucket: LAD[t][0] });
    good.push({ event: "close", id: `g${i}`, settledBucket: t });
  }
  const goodRep = buildReport(gradedRecords(good));
  if (!goodRep.active) fails.push(`good ledger should be active (n=${goodRep.n})`);
  if (!(goodRep.rpsSkill > 0)) fails.push(`sharp-correct forecast should beat climatology: skill=${goodRep.rpsSkill}`);
  if (!(goodRep.meanRPS < goodRep.climatologyRPS)) fails.push("meanRPS should be < climatology RPS");

  // A badly over-confident ledger: always certain on bucket a, truth elsewhere → RPS worse
  // than climatology (negative skill). Verifies the diagnostic actually catches over-confidence.
  const bad = [];
  for (let i = 0; i < 24; i++) {
    const t = 3 + (i % 3); // truth in d/e/f, but forecast is 100% on a
    const dist = { a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 };
    bad.push({ event: "open", id: `b${i}`, ticker: "KXHIGHNY-y", ladder: LAD, dist, heldBucket: "a" });
    bad.push({ event: "close", id: `b${i}`, settledBucket: t });
  }
  const badRep = buildReport(gradedRecords(bad));
  if (!(badRep.rpsSkill < 0)) fails.push(`over-confident-wrong forecast should LOSE to climatology: skill=${badRep.rpsSkill}`);
  if (!(badRep.pit.chi2_reduced > 3)) fails.push(`over-confident forecast should show mis-calibrated PIT: χ²ᵣ=${badRep.pit?.chi2_reduced}`);

  // Under-sample → honest no-op verdict.
  const few = buildReport(gradedRecords([
    { event: "open", id: "x", ticker: "KXHIGHNY-1", ladder: LAD, dist: { c: 1 }, heldBucket: "c" },
    { event: "close", id: "x", settledBucket: 2 },
  ]));
  if (few.active) fails.push("n=1 should be inactive (no-op)");

  // Non-weather tickers ignored.
  const nw = gradedRecords([
    { event: "open", id: "z", ticker: "KXBTC-1", ladder: LAD, dist: { a: 1 } },
    { event: "close", id: "z", settledBucket: 0 },
  ]);
  if (nw.length !== 0) fails.push("non-weather ticker must not be graded");

  return { ok: fails.length === 0, fails };
}

module.exports = {
  rps, pit, pitUniformity, reliability, settledBucketFromHigh, distVector,
  gradedRecords, buildReport, verifyWeatherOracle, selfTest,
  MIN_SAMPLES, WEATHER_PREFIX,
};

if (require.main === module) {
  const r = selfTest();
  process.stdout.write(`Σ₀ kalshi-weather-verify self-test: ${r.ok ? "PASS" : "FAIL"}\n`);
  if (!r.ok) { for (const f of r.fails) process.stdout.write("  - " + f + "\n"); process.exit(1); }
  process.stdout.write(`live: ${verifyWeatherOracle().report}\n`);
}
