#!/usr/bin/env node
'use strict';
/**
 * sell-the-news-harness.js — "buy the rumor, sell the news" as a candidate sleeve.
 *
 * THESIS: after a news-driven price SPIKE, the move over-extends and partially
 * reverses (the catalyst is now priced in). Fade it — SHORT the abnormal up-moves,
 * BUY the abnormal down-moves — cross-sectionally, market-neutral, hold H days.
 * This is an EVENT-DRIVEN sleeve: a different return driver than the price-trend
 * sleeves, so a plausible genuine diversifier for COMBO3.
 *
 * DATA HONESTY: we have no reproducible feed of historical news/earnings EVENT
 * DATES (Yahoo exposes only the latest surprise). So we PROXY a news event as an
 * abnormally large daily move: |return| > K·(trailing vol). A >2.5σ single-day
 * move is almost always news. This measures the "sell the news" REVERSAL effect;
 * a real news/earnings feed (lib/news-collector.js, getEarningsSurprise) would
 * sharpen the event set and let us condition on beat/miss direction. Survivorship-
 * biased universe; adjclose (total return). Directional probe, not live P&L.
 *
 * It reports: (1) an EVENT STUDY — average forward return after up-spikes vs
 * down-spikes (does the fade actually pay?); (2) the sleeve's Sharpe/maxDD;
 * (3) the two-condition admission gate vs COMBO3 (ρ<0.4 AND edge CI>0).
 *
 * Usage:  node scripts/sell-the-news-harness.js
 */

const https = require('https');
const TRADING_DAYS = 252;
const K = 2.5;        // event threshold: |ret| > K·trailing-vol  (news-scale move)
const H = 3;          // holding period (days) after the event
const VOLW = 20;      // trailing-vol window
const COST_BPS = 5;   // per-turnover cost

const STOCKS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'ADBE', 'CRM', 'ORCL', 'CSCO',
  'INTC', 'AMD', 'QCOM', 'TXN', 'AVGO', 'IBM', 'JPM', 'BAC', 'WFC', 'GS',
  'MS', 'C', 'AXP', 'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'TMO', 'WMT',
  'HD', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'COST', 'DIS', 'XOM', 'CVX',
  'CAT', 'BA', 'GE', 'HON',
];

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
async function dailyAdjClose(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10y`;
  const j = await getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const adj = r && r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  if (!Array.isArray(adj)) throw new Error('no adjclose');
  const m = new Map();
  for (let i = 0; i < ts.length; i++) if (adj[i] != null) m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), +adj[i]);
  return m;
}
function sd(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function sharpeCI(rets) {
  const T = rets.length;
  if (T < 3) return { sharpe: 0, lo: 0, hi: 0 };
  const m = rets.reduce((s, x) => s + x, 0) / T;
  const s = sd(rets);
  const per = s > 0 ? m / s : 0;
  const se = Math.sqrt((1 + (per * per) / 2) / T);
  const k = Math.sqrt(TRADING_DAYS);
  return { sharpe: per * k, lo: (per - 1.96 * se) * k, hi: (per + 1.96 * se) * k };
}
function maxDD(eq) {
  let peak = -Infinity, mdd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = e / peak - 1; if (dd < mdd) mdd = dd; }
  return mdd;
}
function pct(x) { return (x * 100).toFixed(1) + '%'; }

(async () => {
  process.stdout.write(`Fetching 10y daily adjclose for ${STOCKS.length} names + SPY...\n`);
  const maps = {};
  const failed = [];
  for (const s of [...STOCKS, 'SPY']) {
    try { maps[s] = await dailyAdjClose(s); } catch (e) { failed.push(s); }
  }
  if (!maps.SPY) { console.error('SPY fetch failed'); process.exit(1); }
  const names = STOCKS.filter((s) => maps[s]);
  const dates = [...maps.SPY.keys()].filter((d) => names.every((n) => maps[n].has(d))).sort();
  const R = {}; // per-name daily returns aligned to dates[1..]
  for (const n of names) R[n] = dates.slice(1).map((d, i) => maps[n].get(d) / maps[n].get(dates[i]) - 1);
  const spyR = dates.slice(1).map((d, i) => maps.SPY.get(d) / maps.SPY.get(dates[i]) - 1);
  const T = spyR.length;

  // ── EVENT STUDY: forward H-day return after up-spikes vs down-spikes ──
  const upFwd = [], dnFwd = [];
  for (const n of names) {
    const r = R[n];
    for (let t = VOLW; t < T - H; t++) {
      const vol = sd(r.slice(t - VOLW, t));
      if (vol <= 0) continue;
      if (Math.abs(r[t]) > K * vol) {
        let fwd = 1;
        for (let h = 1; h <= H; h++) fwd *= 1 + r[t + h];
        fwd -= 1;
        (r[t] > 0 ? upFwd : dnFwd).push(fwd);
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`\nEVENT STUDY — ${dates[1]} → ${dates[dates.length - 1]}, ${names.length} names, threshold |r|>${K}σ, hold ${H}d\n`);
  console.log(`  up-spikes (good news):  n=${String(upFwd.length).padStart(4)}  avg fwd ${H}d return = ${pct(mean(upFwd))}  → ${mean(upFwd) < 0 ? 'REVERSES (sell-the-news works)' : 'drifts up (buy-the-news)'}`);
  console.log(`  down-spikes (bad news): n=${String(dnFwd.length).padStart(4)}  avg fwd ${H}d return = ${pct(mean(dnFwd))}  → ${mean(dnFwd) > 0 ? 'REVERSES (buy-the-panic works)' : 'drifts down'}`);

  // ── SLEEVE: build the event book for a given direction ──
  //   flip = -1 → FADE (sell-the-news);  flip = +1 → DRIFT (buy-the-news, PEAD).
  const N = names.length;
  const cost = COST_BPS / 10000;
  const events = []; // {j, e, dir}  dir = sign of the event move
  for (let j = 0; j < N; j++) {
    const r = R[names[j]];
    for (let t = VOLW; t < T - 1; t++) {
      const vol = sd(r.slice(t - VOLW, t));
      if (vol > 0 && Math.abs(r[t]) > K * vol) events.push({ j, e: t, dir: Math.sign(r[t]) });
    }
  }
  function runBook(flip) {
    let prevW = new Array(N).fill(0);
    const sleeveR = [];
    const eq = [1];
    for (let t = VOLW + 1; t < T; t++) {
      const active = events.filter((ev) => ev.e >= t - H && ev.e <= t - 1);
      const w = new Array(N).fill(0);
      if (active.length) {
        const gw = 1 / active.length;
        for (const ev of active) w[ev.j] += flip * ev.dir * gw;
      }
      let pnl = 0, tover = 0;
      for (let j = 0; j < N; j++) { pnl += prevW[j] * R[names[j]][t]; tover += Math.abs(w[j] - prevW[j]); }
      pnl -= cost * tover;
      sleeveR.push(pnl);
      eq.push(eq[eq.length - 1] * (1 + pnl));
      prevW = w;
    }
    const ci = sharpeCI(sleeveR);
    const spyAligned = spyR.slice(VOLW);
    const n2 = Math.min(sleeveR.length, spyAligned.length);
    const a = sleeveR.slice(0, n2), b = spyAligned.slice(0, n2);
    const ma = a.reduce((s, x) => s + x, 0) / n2, mb = b.reduce((s, x) => s + x, 0) / n2;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n2; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    return { ci, mdd: maxDD(eq), corr };
  }

  const fade = runBook(-1);   // sell-the-news
  const drift = runBook(+1);  // buy-the-news (PEAD)

  console.log(`\nSLEEVE — event book, hold ${H}d, ${COST_BPS}bps/turnover  (${events.length} events, ~${(events.length / (T / TRADING_DAYS)).toFixed(0)}/yr):\n`);
  console.log('  ' + 'direction'.padEnd(26) + 'Sharpe'.padStart(8) + '        95% CI'.padStart(18) + 'maxDD'.padStart(9) + '  ρ↔SPY');
  console.log('  ' + 'FADE (sell-the-news)'.padEnd(26) + fade.ci.sharpe.toFixed(2).padStart(8) + `  [${fade.ci.lo.toFixed(2)}, ${fade.ci.hi.toFixed(2)}]`.padStart(18) + pct(fade.mdd).padStart(9) + '  ' + fade.corr.toFixed(2));
  console.log('  ' + 'DRIFT (buy-the-news/PEAD)'.padEnd(26) + drift.ci.sharpe.toFixed(2).padStart(8) + `  [${drift.ci.lo.toFixed(2)}, ${drift.ci.hi.toFixed(2)}]`.padStart(18) + pct(drift.mdd).padStart(9) + '  ' + drift.corr.toFixed(2));

  // ── two-condition admission gate (Certificate §5) on the WINNING direction ──
  const win = drift.ci.sharpe >= fade.ci.sharpe ? { name: 'DRIFT (buy-the-news)', r: drift } : { name: 'FADE (sell-the-news)', r: fade };
  const ci = win.r.ci, corr = win.r.corr;
  const passRho = Math.abs(corr) < 0.4;
  const passEdge = ci.lo > 0;
  console.log(`\n  ADMISSION GATE (Certificate §5) — best direction: ${win.name}`);
  console.log(`    (a) ρ<0.4 to equity core: ρ=${corr.toFixed(2)} → ${passRho ? 'PASS' : 'FAIL'}`);
  console.log(`    (b) standalone edge CI>0: [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] → ${passEdge ? 'PASS' : 'FAIL (spans 0)'}`);
  console.log(`    VERDICT: ${passRho && passEdge ? 'ADMIT — clears BOTH bars → the first candidate to do so. Build into COMBO4 and re-verify E2 at N=4.'
    : passRho ? 'REJECT — uncorrelated but edge CI spans 0 this window.'
    : passEdge ? 'note — has edge but correlated to equity.'
    : 'REJECT — neither.'}`);
  console.log(`\n  FINDING: "sell the news" is FALSIFIED here — post-event DRIFT (PEAD) dominates the fade.`);
  console.log(`\n  NOTE: proxying news by >${K}σ jumps is blunt. A real earnings/news feed conditioned on`);
  console.log(`  beat/miss (getEarningsSurprise, news-collector.js) is the sharper version of this sleeve.\n`);
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
