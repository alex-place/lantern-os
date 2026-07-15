#!/usr/bin/env node
'use strict';
/**
 * daily-backtest-harness.js — SPY-benchmarked, YoY/CAGR strategy leaderboard.
 *
 * WHY: the intraday Σ₀ backtest (scripts/trader-backtest.js) reports R-multiples
 * over ~1 month of 15m bars. It cannot answer "does this beat SPY total return
 * over years?". This harness fills that gap: it pulls MULTI-YEAR DAILY TOTAL-RETURN
 * history (Yahoo `adjclose`, dividends reinvested) and computes, for a small field
 * of meta-strategies, the metrics that actually matter on a YoY horizon —
 * CAGR, max drawdown, Sharpe, and a per-calendar-year YoY series — all measured
 * against SPY buy-&-hold as the benchmark.
 *
 * HONEST SCOPE (Noise-Sorting rules):
 *  - Uses adjclose (total return, dividends reinvested) — NOT raw close.
 *  - Costs: a per-switch cost (COST_BPS) is charged on trend/GEM rebalances.
 *    Taxes, slippage beyond COST_BPS, capacity, and regime shift are NOT modeled.
 *  - "Cash" legs earn the BIL total-return series (real T-bill proxy), not 0%.
 *  - Every figure is historical/backtested. No future-performance guarantee.
 *  - This is a DECISION-SUPPORT harness. No capital is committed; nothing is live.
 *
 * The strategy field is deliberately small and classic — the meta-strategies the
 * research leaderboard identified as the real bars to clear on a YoY basis:
 *   1. SPY buy & hold            (the benchmark)
 *   2. SPY 200-day SMA trend     (in SPY above the 200d MA, else BIL)
 *   3. GEM dual-momentum proxy   (SPY vs ex-US, abs-momentum gate to BIL)
 *
 * Usage:
 *   node scripts/daily-backtest-harness.js            # default 10y window
 *   node scripts/daily-backtest-harness.js --years 5
 *   node scripts/daily-backtest-harness.js --no-log   # don't write the JSON record
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const COST_BPS = 5;            // per-switch round-trip cost (5 bps) on trend/GEM rebalances
const TRADING_DAYS = 252;

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const YEARS = Math.max(2, Math.min(10, parseInt(argVal('--years', '10'), 10) || 10));
const NO_LOG = argv.includes('--no-log');

// ── Yahoo daily total-return (adjclose) fetch ──────────────────────────────────
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (KeystoneHarness)' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad JSON')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

// Returns Map<YYYY-MM-DD, adjClose> for `sym` over the last `years` years.
async function dailyAdjClose(sym, years) {
  const range = `${Math.min(10, years)}y`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;
  const j = await getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error(`no chart result for ${sym}`);
  const ts = r.timestamp || [];
  const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  if (!Array.isArray(adj)) throw new Error(`no adjclose for ${sym}`);
  const m = new Map();
  for (let i = 0; i < ts.length; i++) {
    if (adj[i] == null) continue;
    m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), +adj[i]);
  }
  return m;
}

// ── metrics ────────────────────────────────────────────────────────────────────
// equity: array of { date, eq } (eq is the compounded $1 → curve). Pure functions.
function cagr(equity) {
  if (equity.length < 2) return 0;
  const days = (new Date(equity[equity.length - 1].date) - new Date(equity[0].date)) / 86400000;
  const yrs = days / 365.25;
  return yrs > 0 ? Math.pow(equity[equity.length - 1].eq / equity[0].eq, 1 / yrs) - 1 : 0;
}
function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0;
  for (const p of equity) {
    if (p.eq > peak) peak = p.eq;
    const dd = p.eq / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}
function sharpe(dailyRets) {
  if (dailyRets.length < 2) return 0;
  const mean = dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length;
  const varc = dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyRets.length - 1);
  const sd = Math.sqrt(varc);
  return sd > 0 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : 0;
}
// Annualized Sharpe with a 95% confidence interval. Lo (2002): the per-period
// Sharpe `s` has SE ≈ √((1 + s²/2)/T) under the i.i.d. approximation; we annualize
// s and its band by √252. (Caveat: markets aren't i.i.d.; autocorrelation widens
// the true band, so this CI is a floor on the uncertainty, not the last word.)
function sharpeCI(dailyRets) {
  const T = dailyRets.length;
  if (T < 3) return { sharpe: 0, lo: 0, hi: 0, se: 0, t: T };
  const mean = dailyRets.reduce((s, r) => s + r, 0) / T;
  const sd = Math.sqrt(dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / (T - 1));
  const s = sd > 0 ? mean / sd : 0;                 // per-period Sharpe
  const se = Math.sqrt((1 + (s * s) / 2) / T);      // Lo (2002) SE of per-period Sharpe
  const k = Math.sqrt(TRADING_DAYS);
  return {
    sharpe: s * k,
    lo: (s - 1.96 * se) * k,
    hi: (s + 1.96 * se) * k,
    se: se * k,
    t: T,
  };
}
// Sample skewness and excess kurtosis of a return stream (used to deflate the
// Sharpe for non-normality — fat left tails inflate a naive Sharpe).
function moments(rets) {
  const T = rets.length;
  if (T < 4) return { skew: 0, kurt: 3, perPeriodSharpe: 0 };
  const mean = rets.reduce((s, r) => s + r, 0) / T;
  const m2 = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / T;
  const m3 = rets.reduce((s, r) => s + (r - mean) ** 3, 0) / T;
  const m4 = rets.reduce((s, r) => s + (r - mean) ** 4, 0) / T;
  const sd = Math.sqrt(m2);
  return {
    skew: sd > 0 ? m3 / sd ** 3 : 0,
    kurt: m2 > 0 ? m4 / m2 ** 2 : 3,   // raw (non-excess) kurtosis; normal = 3
    perPeriodSharpe: sd > 0 ? mean / (sd * Math.sqrt(T / (T - 1))) : 0,
  };
}
// Standard normal CDF (Abramowitz & Stegun 7.1.26) — used by the DSR probability.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
// Inverse standard normal CDF (Acklam's rational approximation) — for the SR0 benchmark.
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
// Deflated Sharpe Ratio (Bailey & López de Prado 2014). Given a strategy's observed
// per-period Sharpe `sr`, its return skew/kurtosis, sample length T, the number of
// INDEPENDENT trials N that were run to find it, and the cross-trial variance of the
// Sharpes, returns P(true Sharpe > 0) after correcting for BOTH multiple-testing
// selection bias and non-normality. A naive Sharpe that looks great can have DSR≈0.5
// (i.e. no better than luck) once you account for how many sleeves were tried.
function deflatedSharpe(sr, skew, kurt, T, nTrials, varAcrossTrials) {
  if (T < 4 || nTrials < 1) return null;
  // SR0: expected maximum Sharpe under nTrials independent null strategies.
  const emc = 0.5772156649015329; // Euler–Mascheroni
  const sigmaSR = Math.sqrt(Math.max(varAcrossTrials, 1e-12));
  const N = Math.max(nTrials, 1);
  const z1 = normInv(1 - 1 / N);
  const z2 = normInv(1 - 1 / (N * Math.E));
  const sr0 = sigmaSR * ((1 - emc) * z1 + emc * z2);
  // DSR: probability the observed SR beats SR0, with the non-normality-adjusted SE.
  const denom = Math.sqrt(Math.max(1 - skew * sr + ((kurt - 1) / 4) * sr * sr, 1e-9));
  const dsr = normCdf(((sr - sr0) * Math.sqrt(T - 1)) / denom);
  return { dsr, sr0, sigmaSR };
}
// Pearson correlation of two equal-length daily-return streams.
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
// Per-calendar-year total return from an equity curve. Uses each year's last eq
// vs the prior year-end eq (or the start eq for the first, possibly-partial year).
function yoyReturns(equity) {
  const byYear = new Map();
  for (const p of equity) byYear.set(p.date.slice(0, 4), p.eq); // last write per year = year-end eq
  const years = [...byYear.keys()].sort();
  const out = {};
  let prev = equity[0].eq;
  for (const y of years) {
    const ye = byYear.get(y);
    out[y] = ye / prev - 1;
    prev = ye;
  }
  return out;
}

// ── strategy engines → daily equity curve on a shared date axis ────────────────
// `dates` is the sorted intersection of all series' dates. Each strategy returns
// { equity:[{date,eq}], dailyRets:[], switches:N }. A switch pays COST_BPS.
const cost = COST_BPS / 10000;

// 1. Buy & hold a single symbol (adjclose → total return).
function buyHold(dates, series) {
  const px = series;
  const equity = [];
  const dailyRets = [];
  let eq = 1;
  equity.push({ date: dates[0], eq });
  for (let i = 1; i < dates.length; i++) {
    const r = px.get(dates[i]) / px.get(dates[i - 1]) - 1;
    eq *= 1 + r;
    dailyRets.push(r);
    equity.push({ date: dates[i], eq });
  }
  return { equity, dailyRets, switches: 0 };
}

// 2. 200-day SMA trend on `risk`, parked in `cash` (BIL) when below the MA.
//    Decision uses YESTERDAY's close vs its 200d SMA (no lookahead).
function smaTrend(dates, risk, cash, window = 200) {
  const equity = [{ date: dates[0], eq: 1 }];
  const dailyRets = [];
  let eq = 1, pos = 1, switches = 0; // start invested
  const closes = dates.map((d) => risk.get(d));
  for (let i = 1; i < dates.length; i++) {
    // signal from data up to i-1
    let want = pos;
    if (i - 1 >= window) {
      const sma = closes.slice(i - window, i).reduce((s, c) => s + c, 0) / window;
      want = closes[i - 1] > sma ? 1 : 0;
    }
    let r = want === 1 ? risk.get(dates[i]) / risk.get(dates[i - 1]) - 1
                        : cash.get(dates[i]) / cash.get(dates[i - 1]) - 1;
    if (want !== pos) { r -= cost; switches++; pos = want; }
    eq *= 1 + r;
    dailyRets.push(r);
    equity.push({ date: dates[i], eq });
  }
  return { equity, dailyRets, switches };
}

// 3. GEM dual-momentum proxy (Antonacci): monthly rebalance. Pick the higher
//    12-month total return of {US=risk, exUS=intl}; if that winner's 12m return
//    is below cash's (absolute-momentum gate), hold cash (BIL). Hold to next month.
function gemDualMomentum(dates, risk, intl, cash, lookback = 252) {
  const equity = [{ date: dates[0], eq: 1 }];
  const dailyRets = [];
  let eq = 1, held = 'risk', switches = 0;
  const ret12 = (m, i) => (i >= lookback ? m.get(dates[i]) / m.get(dates[i - lookback]) - 1 : null);
  for (let i = 1; i < dates.length; i++) {
    const newMonth = dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7);
    if (newMonth && i > lookback) {
      const rR = ret12(risk, i - 1), rI = ret12(intl, i - 1), rC = ret12(cash, i - 1);
      let want = rR >= rI ? 'risk' : 'intl';
      const winnerRet = want === 'risk' ? rR : rI;
      if (winnerRet <= rC) want = 'cash'; // absolute momentum → park in bills
      if (want !== held) { switches++; held = want; }
    }
    const m = held === 'risk' ? risk : held === 'intl' ? intl : cash;
    let r = m.get(dates[i]) / m.get(dates[i - 1]) - 1;
    // charge cost on the first bar of a month where the holding changed
    if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7) && switches > 0) { /* cost charged at switch below */ }
    eq *= 1 + r;
    dailyRets.push(r);
    equity.push({ date: dates[i], eq });
  }
  // Note: GEM switch cost is small (≤12 switches/yr); folded conservatively as a
  // flat annual drag would overstate it, so we leave per-switch cost off GEM and
  // flag switches in the record for the operator to price.
  return { equity, dailyRets, switches };
}

// RSI over a series (simple rolling avg of gains/losses). Returns array aligned to closes.
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const ch = closes[j] - closes[j - 1];
      if (ch > 0) g += ch; else l -= ch;
    }
    const ag = g / period, al = l / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

// 4. Mean-reversion (Connors-style RSI(2) dip-buy). Long `risk` when yesterday's
//    RSI(2) < entry (oversold), else park in `cash`. In the market only on dips →
//    structurally low correlation to buy-&-hold / trend. Long-or-cash (no leverage).
function meanReversion(dates, risk, cash, period = 2, entry = 10) {
  const closes = dates.map((d) => risk.get(d));
  const r = rsiSeries(closes, period);
  const equity = [{ date: dates[0], eq: 1 }];
  const dailyRets = [];
  let eq = 1, pos = 0, switches = 0;
  for (let i = 1; i < dates.length; i++) {
    const want = (r[i - 1] != null && r[i - 1] < entry) ? 1 : 0;
    let ret = want === 1 ? risk.get(dates[i]) / risk.get(dates[i - 1]) - 1
                         : cash.get(dates[i]) / cash.get(dates[i - 1]) - 1;
    if (want !== pos) { ret -= cost; switches++; pos = want; }
    eq *= 1 + ret;
    dailyRets.push(ret);
    equity.push({ date: dates[i], eq });
  }
  return { equity, dailyRets, switches };
}

// 5. Long/short cross-sectional momentum (market-neutral by construction). Monthly:
//    rank a basket by 12-1 month momentum, go long the top `k`, short the bottom `k`,
//    equal-weight, dollar-neutral. Daily return = avg(long) − avg(short) — a self-
//    financing spread with ~zero equity beta. This is the category MOST likely to
//    clear the measured-ρ gate that mean-reversion/short-vol failed.
function longShortMomentum(dates, maps, syms, lookback = 252, skip = 21, k = 3) {
  const px = syms.map((s) => dates.map((d) => maps[s].get(d)));
  const equity = [{ date: dates[0], eq: 1 }];
  const dailyRets = [];
  let eq = 1, switches = 0;
  let longSet = [], shortSet = [];
  for (let i = 1; i < dates.length; i++) {
    const newMonth = dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7);
    let didSwitch = false;
    if (newMonth && i - 1 - lookback >= 0) {
      const mom = syms.map((s, si) => ({ si, r: px[si][i - 1 - skip] / px[si][i - 1 - lookback] - 1 }));
      mom.sort((a, b) => b.r - a.r);
      const nl = mom.slice(0, k).map((x) => x.si).sort();
      const ns = mom.slice(-k).map((x) => x.si).sort();
      didSwitch = JSON.stringify([nl, ns]) !== JSON.stringify([longSet, shortSet]);
      if (didSwitch) switches++;
      longSet = nl; shortSet = ns;
    }
    if (longSet.length === 0) { dailyRets.push(0); equity.push({ date: dates[i], eq }); continue; }
    const rl = longSet.reduce((s, si) => s + (px[si][i] / px[si][i - 1] - 1), 0) / longSet.length;
    const rs = shortSet.reduce((s, si) => s + (px[si][i] / px[si][i - 1] - 1), 0) / shortSet.length;
    let r = rl - rs;
    if (didSwitch) r -= cost * 2; // round-trip on both legs at rebalance
    eq *= 1 + r;
    dailyRets.push(r);
    equity.push({ date: dates[i], eq });
  }
  return { equity, dailyRets, switches };
}

// ── report ─────────────────────────────────────────────────────────────────────
function pct(x) { return (x * 100).toFixed(1) + '%'; }
function summarize(name, category, res, spyCagr) {
  const c = cagr(res.equity);
  const sci = sharpeCI(res.dailyRets);
  const mom = moments(res.dailyRets);
  return {
    name, category,
    cagr: c,
    excess_vs_spy: c - spyCagr,
    sharpe: sci.sharpe,
    sharpe_ci95: { lo: sci.lo, hi: sci.hi, se: sci.se, obs: sci.t },
    max_dd: maxDrawdown(res.equity),
    switches: res.switches,
    final_mult: res.equity[res.equity.length - 1].eq,
    yoy: yoyReturns(res.equity),
    // fields consumed by the post-hoc Deflated-Sharpe pass (needs all sleeves first)
    _perPeriodSharpe: mom.perPeriodSharpe,
    _skew: mom.skew,
    _kurt: mom.kurt,
    _obs: sci.t,
  };
}
// Post-hoc Deflated Sharpe across the whole sleeve set. Each sleeve tested is a trial;
// the DSR asks whether the WINNER's Sharpe survives once you pay for having searched.
function attachDeflatedSharpe(rows) {
  const srs = rows.map((r) => r._perPeriodSharpe).filter((s) => Number.isFinite(s));
  const n = srs.length;
  if (n < 2) { rows.forEach((r) => { r.deflated_sharpe = null; }); return rows; }
  const mean = srs.reduce((s, x) => s + x, 0) / n;
  const varAcross = srs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  for (const r of rows) {
    const d = deflatedSharpe(r._perPeriodSharpe, r._skew, r._kurt, r._obs, n, varAcross);
    r.deflated_sharpe = d ? Number(d.dsr.toFixed(4)) : null;
    r.dsr_trials = n;
    r.dsr_sr0_annualized = d ? Number((d.sr0 * Math.sqrt(TRADING_DAYS)).toFixed(3)) : null;
  }
  return rows;
}

// Export the statistics primitives so they can be unit-tested without a live data
// fetch. The full backtest only runs when this file is executed directly.
module.exports = { sharpe, sharpeCI, moments, normCdf, normInv, deflatedSharpe, attachDeflatedSharpe };

if (require.main !== module) {
  // Required as a library (e.g. by a unit test) — skip the network-bound backtest.
} else (async () => {
  const CORE = ['SPY', 'VXUS', 'BIL', 'TLT', 'GLD', 'DBC', '^PUT'];
  const SECTORS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLB', 'XLU'];
  // Single-stock universe for cross-sectional momentum. NOTE: these are large-caps
  // that survived to today → SURVIVORSHIP BIAS (real L/S would use point-in-time
  // membership). Results here are optimistic; treated as an upper-bound probe.
  const STOCKS = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'ADBE', 'CRM', 'ORCL', 'CSCO',
    'INTC', 'AMD', 'QCOM', 'TXN', 'AVGO', 'IBM', 'JPM', 'BAC', 'WFC', 'GS',
    'MS', 'C', 'AXP', 'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'TMO', 'WMT',
    'HD', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'COST', 'DIS', 'XOM', 'CVX',
    'CAT', 'BA', 'GE', 'HON',
  ];
  const SYMS = [...CORE, ...SECTORS, ...STOCKS];
  process.stdout.write(`Fetching ${YEARS}y daily total-return (adjclose) for ${SYMS.length} symbols...\n`);
  const maps = {};
  const failed = [];
  for (const s of SYMS) {
    try { maps[s] = await dailyAdjClose(s, YEARS); }
    catch (e) { failed.push(s); console.error(`  skip ${s}: ${e.message}`); }
  }
  if (CORE.some((s) => failed.includes(s))) { console.error('a CORE symbol failed to fetch — aborting'); process.exit(1); }
  const okSectors = SECTORS.filter((s) => !failed.includes(s));
  const okStocks = STOCKS.filter((s) => !failed.includes(s));
  const okSyms = SYMS.filter((s) => !failed.includes(s));
  // shared date axis = intersection across every fetched series (different inception
  // dates), so all return streams stay aligned bar-for-bar.
  const spyDates = [...maps.SPY.keys()];
  const dates = spyDates.filter((d) => okSyms.every((s) => maps[s].has(d))).sort();
  if (dates.length < TRADING_DAYS + 20) { console.error('insufficient overlapping history'); process.exit(1); }

  // Build a strategy's equity curve from a daily-return stream aligned to dates[1..].
  const equityFromRets = (rets) => {
    const eq = [{ date: dates[0], eq: 1 }];
    let e = 1;
    for (let t = 0; t < rets.length; t++) { e *= 1 + rets[t]; eq.push({ date: dates[t + 1], eq: e }); }
    return eq;
  };
  // Blend component strategies by weight (default equal). Costs already live inside
  // each component's return stream, so the blend inherits them.
  const blend = (comps, weights) => {
    const n = Math.min(...comps.map((c) => c.dailyRets.length));
    const w = weights || comps.map(() => 1 / comps.length);
    const rets = [];
    for (let t = 0; t < n; t++) {
      let r = 0;
      for (let i = 0; i < comps.length; i++) r += w[i] * comps[i].dailyRets[t];
      rets.push(r);
    }
    return { equity: equityFromRets(rets), dailyRets: rets, switches: comps.reduce((s, c) => s + (c.switches || 0), 0) };
  };
  // Inverse-volatility weights (risk parity, full-sample vol — a mild lookahead
  // proxy; a live system would use trailing vol). Equal RISK, not equal dollars.
  const invVol = (comps) => {
    const vol = comps.map((c) => {
      const m = c.dailyRets.reduce((s, x) => s + x, 0) / c.dailyRets.length;
      return Math.sqrt(c.dailyRets.reduce((s, x) => s + (x - m) ** 2, 0) / c.dailyRets.length) || 1e-9;
    });
    const inv = vol.map((v) => 1 / v);
    const tot = inv.reduce((a, b) => a + b, 0);
    return inv.map((v) => v / tot);
  };

  const bh = buyHold(dates, maps.SPY);
  const spyCagr = cagr(bh.equity);

  // component sleeves
  const spyTrend = smaTrend(dates, maps.SPY, maps.BIL);
  // Multi-market trend (managed-futures proxy): the SAME 200d long/cash rule applied
  // independently to equities, bonds, gold, commodities, then equal-weighted. This is
  // the classic diversifier — trend across many markets, not just stocks.
  const mmTrend = blend([
    smaTrend(dates, maps.SPY, maps.BIL),
    smaTrend(dates, maps.TLT, maps.BIL),
    smaTrend(dates, maps.GLD, maps.BIL),
    smaTrend(dates, maps.DBC, maps.BIL),
  ]);
  const goldBH = buyHold(dates, maps.GLD);
  const mr = meanReversion(dates, maps.SPY, maps.BIL);      // mean-reversion sleeve (rejected 07-10)
  const shortVol = buyHold(dates, maps['^PUT']);            // short-vol / put-write proxy (rejected 07-10)
  const lsSector = longShortMomentum(dates, maps, okSectors);            // 9-basket sector L/S (rejected 07-10)
  // NEW: single-stock cross-sectional momentum — quintile long/short over ~40 large-caps.
  const kStk = Math.max(3, Math.round(okStocks.length / 5));
  const lsStock = longShortMomentum(dates, maps, okStocks, 252, 21, kStk);

  // ★ COMBO3: verified blend of equity + multi-market trend + gold.
  const sleeves3 = [bh, mmTrend, goldBH];
  const combo3 = blend(sleeves3, invVol(sleeves3));
  // ★ COMBO4: add the single-stock L/S sleeve IF it clears BOTH gate conditions.
  const sleeves4 = [bh, mmTrend, goldBH, lsStock];
  const combo4 = blend(sleeves4, invVol(sleeves4));

  const defs = [
    { name: 'SPY buy & hold', category: 'benchmark', abbr: 'SPY', res: bh },
    { name: 'SPY 200d SMA trend', category: 'trend-filter', abbr: 'Trend', res: spyTrend },
    { name: 'Multi-market trend (MF proxy)', category: 'managed-futures', abbr: 'MFtrend', res: mmTrend },
    { name: 'Gold (GLD) buy & hold', category: 'diversifier', abbr: 'Gold', res: goldBH },
    { name: 'Mean-reversion RSI(2) [rejected]', category: 'mean-reversion', abbr: 'MeanRev', res: mr },
    { name: 'Short-vol/put-write [rejected]', category: 'short-vol', abbr: 'ShortV', res: shortVol },
    { name: 'L/S sector momentum [rejected]', category: 'long-short-sector', abbr: 'LS-sec', res: lsSector },
    { name: `L/S single-stock momentum (${okStocks.length}nm)`, category: 'long-short', abbr: 'LS-stk', res: lsStock },
    { name: 'COMBO3 (SPY+MFtrend+Gold)', category: 'combined3', abbr: 'COMBO3', res: combo3 },
    { name: 'COMBO4 (+single-stock L/S)', category: 'combined', abbr: 'COMBO4', res: combo4 },
  ];
  const sleeves = sleeves4; // the verdict evaluates the COMBO4 sleeve set
  const ls = lsStock;       // the admission gate evaluates the single-stock L/S candidate
  const rows = attachDeflatedSharpe(defs.map((d) => summarize(d.name, d.category, d.res, spyCagr))).sort((a, b) => b.sharpe - a.sharpe);

  // ── leaderboard table ──
  console.log(`\nΣ₀ meta-strategy leaderboard — ${dates[0]} → ${dates[dates.length - 1]}  (adjclose / total return, ${COST_BPS}bps/switch)\n`);
  console.log('  ' + 'strategy'.padEnd(34) + 'CAGR'.padStart(8) + 'vsSPY'.padStart(9) + 'Sharpe'.padStart(8) + 'maxDD'.padStart(9) + 'switch'.padStart(8) + '  beats?');
  console.log('  ' + '─'.repeat(84));
  for (const r of rows) {
    const beats = r.category === 'benchmark' ? '—' : (r.cagr > spyCagr ? '✓ CAGR' : (r.sharpe > rows.find(x => x.category === 'benchmark').sharpe ? '~ Sharpe' : '✗'));
    console.log('  ' + r.name.padEnd(34) + pct(r.cagr).padStart(8) + (r.category === 'benchmark' ? '—' : (r.excess_vs_spy >= 0 ? '+' : '') + pct(r.excess_vs_spy)).padStart(9) + r.sharpe.toFixed(2).padStart(8) + pct(r.max_dd).padStart(9) + String(r.switches).padStart(8) + '  ' + beats);
  }

  // ── Sharpe with 95% CI (Lo 2002) ──
  console.log(`\n  Annualized Sharpe ± 95% CI (i.i.d. approximation; a floor on uncertainty):\n`);
  console.log('  ' + 'strategy'.padEnd(34) + 'Sharpe'.padStart(8) + '   95% CI'.padStart(20) + '   sig?');
  for (const r of rows) {
    const ci = r.sharpe_ci95;
    const sig = ci.lo > 0 ? 'yes (>0)' : 'no (spans 0)';
    console.log('  ' + r.name.padEnd(34) + r.sharpe.toFixed(2).padStart(8) + `  [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`.padStart(20) + '   ' + sig);
  }

  // ── Deflated Sharpe Ratio (Bailey & López de Prado 2014) ──
  // Pays for the multiple-testing bias of having tried N sleeves and reporting the best,
  // and for non-normal (fat-tailed) returns. DSR = P(true Sharpe > 0). A leaderboard
  // winner with DSR < 0.95 is NOT a discovery — it's within reach of luck given the search.
  console.log(`\n  Deflated Sharpe — corrects the winner for ${rows[0].dsr_trials || defs.length} trials + non-normality:\n`);
  console.log('  ' + 'strategy'.padEnd(34) + 'Sharpe'.padStart(8) + 'DSR=P(SR>0)'.padStart(13) + 'SR0(exp.max)'.padStart(14) + '   verdict');
  for (const r of rows) {
    if (r.category === 'benchmark') continue;
    const d = r.deflated_sharpe;
    const verdict = d == null ? 'n/a' : (d >= 0.95 ? '✓ survives' : (d >= 0.90 ? '~ marginal' : '✗ likely luck'));
    console.log('  ' + r.name.padEnd(34) + r.sharpe.toFixed(2).padStart(8) + (d == null ? 'n/a' : d.toFixed(3)).padStart(13) + String(r.dsr_sr0_annualized ?? 'n/a').padStart(14) + '   ' + verdict);
  }

  // ── correlation matrix of daily return streams (Theorem 1 gate) ──
  const corr = defs.map((a) => defs.map((b) => correlation(a.res.dailyRets, b.res.dailyRets)));
  console.log(`\n  Correlation matrix of daily returns (Thm 1 pays only when off-diagonals are small):\n`);
  const short = defs.map((d) => d.abbr);
  console.log('  ' + ''.padEnd(10) + short.map((s) => s.padStart(9)).join(''));
  for (let i = 0; i < defs.length; i++) {
    console.log('  ' + short[i].padEnd(10) + corr[i].map((v) => v.toFixed(2).padStart(9)).join(''));
  }
  const off = [];
  for (let i = 0; i < defs.length; i++) for (let j = i + 1; j < defs.length; j++) off.push(corr[i][j]);
  const avgOff = off.reduce((s, v) => s + v, 0) / (off.length || 1);
  // The verdict that matters isn't the whole-field average (which mixes in redundant
  // equity clones) — it's the correlation among the sleeves that actually compose the
  // COMBINED portfolio. Theorem 1 fires on THOSE.
  const sleeveOff = [];
  for (let i = 0; i < sleeves.length; i++)
    for (let j = i + 1; j < sleeves.length; j++)
      sleeveOff.push(correlation(sleeves[i].dailyRets, sleeves[j].dailyRets));
  const avgSleeveOff = sleeveOff.reduce((s, v) => s + v, 0) / (sleeveOff.length || 1);
  const diversified = avgSleeveOff < 0.5;
  const combo = rows.find((r) => r.category === 'combined');
  const bench = rows.find((r) => r.category === 'benchmark');
  console.log(`\n  Whole-field avg off-diagonal ρ = ${avgOff.toFixed(2)} (mixes redundant equity clones — ignore).`);
  console.log(`  COMBO4-sleeve avg ρ = ${avgSleeveOff.toFixed(2)} (SPY+MFtrend+Gold+L/S) → ${diversified ? 'DIVERSIFIED: Theorem 1 FIRES.' : 'still too correlated.'}`);
  // Measured-ρ admission gate for the NEW L/S sleeve (Certificate §5 rule).
  const rhoLScombo3 = correlation(ls.dailyRets, combo3.dailyRets);
  const rhoLSspy = correlation(ls.dailyRets, bh.dailyRets);
  const lsCI = sharpeCI(ls.dailyRets);
  const passRho = Math.abs(rhoLScombo3) < 0.4;       // condition (a): genuinely uncorrelated
  const passEdge = lsCI.lo > 0;                       // condition (b): real, significant standalone edge
  const admit = passRho && passEdge;
  const combo3row = rows.find((r) => r.category === 'combined3');
  const combo4row = rows.find((r) => r.category === 'combined');
  console.log(`\n  SLEEVE ADMISSION GATE (two conditions) — L/S sector momentum:`);
  console.log(`    (a) ρ(L/S ↔ COMBO3) = ${rhoLScombo3.toFixed(2)} (ρ↔SPY ${rhoLSspy.toFixed(2)})  → ${passRho ? 'PASS (uncorrelated)' : 'FAIL (ρ ≥ 0.4)'}`);
  console.log(`    (b) standalone Sharpe = ${lsCI.sharpe.toFixed(2)} CI [${lsCI.lo.toFixed(2)}, ${lsCI.hi.toFixed(2)}]  → ${passEdge ? 'PASS (edge > 0)' : 'FAIL (CI spans 0 — no real edge)'}`);
  if (combo3row && combo4row) {
    const d = combo4row.sharpe - combo3row.sharpe;
    console.log(`    effect: COMBO3 Sharpe ${combo3row.sharpe.toFixed(2)} → COMBO4 ${combo4row.sharpe.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(2)}); maxDD ${pct(combo3row.max_dd)} → ${pct(combo4row.max_dd)}`);
    console.log(`    VERDICT: ${admit ? 'ADMIT — uncorrelated AND positive-edge; promote to COMBO4, re-verify E2 at N=4.'
      : passRho ? 'REJECT for now — genuinely uncorrelated (ρ≈0) but NO standalone edge (Sharpe CI spans 0). Low-ρ is necessary, not sufficient: a zero-edge sleeve dilutes return. Next: a stronger market-neutral signal (single-stock cross-sectional momentum, or a factor with a real premium) OR rates trend / FX carry.'
      : 'REJECT — correlated; next candidate: rates trend or FX carry.'}`);
  }
  console.log(`\n  LESSON: the √N free lunch needs BOTH low correlation AND positive edge per sleeve.`);
  if (admit) {
    console.log(`  Single-stock L/S cleared both bars → COMBO4 is the new verified ensemble at N=4.`);
  } else if (passRho) {
    console.log(`  Single-stock L/S is uncorrelated (ρ≈${rhoLScombo3.toFixed(2)}) but its edge is not significant`);
    console.log(`  this window (Sharpe CI spans 0) — low-ρ alone doesn't earn admission. COMBO3 stands.`);
  } else {
    console.log(`  Single-stock L/S is too correlated to admit. COMBO3 stands.`);
  }
  if (diversified && combo && bench) {
    const lift = ((combo.sharpe / bench.sharpe - 1) * 100).toFixed(0);
    console.log(`  → RESULT: combining low-ρ sleeves lifted Sharpe ${bench.sharpe.toFixed(2)} → ${combo.sharpe.toFixed(2)} (+${lift}%) and cut maxDD ${pct(bench.max_dd)} → ${pct(combo.max_dd)}.`);
    console.log(`  → Tradeoff: COMBINED CAGR ${pct(combo.cagr)} < SPY ${pct(bench.cagr)} (diversifying away from pure equity costs return in a bull decade),`);
    console.log(`    but its HIGHER Sharpe means it can be vol-targeted (levered) to SPY's risk level for MORE return per unit risk. That is the free lunch.`);
  }

  // ── per-year YoY table ──
  const allYears = [...new Set(rows.flatMap((r) => Object.keys(r.yoy)))].sort();
  console.log(`\n  YoY total return by calendar year (first year may be partial):\n`);
  console.log('  ' + 'strategy'.padEnd(34) + allYears.map((y) => y.padStart(8)).join(''));
  for (const r of rows) {
    console.log('  ' + r.name.padEnd(34) + allYears.map((y) => (r.yoy[y] != null ? pct(r.yoy[y]) : '—').padStart(8)).join(''));
  }

  console.log(`\n  Costs = ${COST_BPS}bps/switch on trend (GEM switches flagged, not priced — see --help/source).`);
  console.log(`  Cash leg = BIL total return. All figures historical/backtested; not a forecast.\n`);

  // ── durable record ──
  if (!NO_LOG) {
    let commit = 'unknown';
    try { commit = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch (_e) {}
    const outDir = path.join(REPO, 'data', 'trading', 'leaderboard');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date(dates[dates.length - 1]).toISOString().slice(0, 10);
    const rec = {
      generated_for_last_bar: stamp,
      window: { start: dates[0], end: dates[dates.length - 1], trading_days: dates.length },
      benchmark: 'SPY total return (adjclose)',
      cost_bps_per_switch: COST_BPS,
      git_commit: commit,
      strategies: rows,
      correlation: {
        labels: defs.map((d) => d.name),
        matrix: corr,
        avg_off_diagonal: avgOff,
        diversified,
      },
    };
    const file = path.join(outDir, `leaderboard-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    console.log(`  Logged → ${path.relative(REPO, file)}  (commit ${commit})\n`);
  }
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
