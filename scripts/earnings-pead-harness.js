#!/usr/bin/env node
'use strict';
/**
 * earnings-pead-harness.js — the SHARPENED "buy the news" sleeve: real earnings
 * surprises (Post-Earnings-Announcement Drift), not a >2.5σ jump proxy.
 *
 * The sell-the-news harness falsified the fade and showed the real effect is DRIFT,
 * but a blunt jump-proxy left the edge insignificant after costs. This version uses
 * ACTUAL earnings events: exact report date + actual-vs-consensus EPS surprise from
 * Nasdaq (keyless). Thesis (PEAD, one of the most robust anomalies): stocks that
 * BEAT drift up for days/weeks after; stocks that MISS drift down. Trade WITH the
 * surprise, cross-sectionally, market-neutral.
 *
 * DATA HONESTY: Nasdaq's keyless endpoint returns only the last ~4 quarters, so the
 * backtest window is ~1 YEAR (~4 events × N names). That is a SHORT window — Sharpe
 * CIs are wide and this is a directional probe, not a decade-verified sleeve. The
 * EVENT STUDY (avg drift after beats vs misses) is the cleaner, higher-n signal. A
 * keyed API (Alpha Vantage / FMP) would extend this to 10y and tighten every CI.
 * Prices are adjclose (total return); entry at the close of the first trading day
 * on/after the report (no lookahead); survivorship-biased universe.
 *
 * Usage:  node scripts/earnings-pead-harness.js
 */

const https = require('https');
const TRADING_DAYS = 252;
const HOLD = [1, 3, 5, 10];   // event-study horizons (days)
const H = 10;                 // sleeve holding period
const COST_BPS = 5;

const STOCKS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'ADBE', 'CRM', 'ORCL', 'CSCO',
  'INTC', 'AMD', 'QCOM', 'TXN', 'AVGO', 'IBM', 'JPM', 'BAC', 'WFC', 'GS',
  'MS', 'C', 'AXP', 'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'TMO', 'WMT',
  'HD', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'COST', 'DIS', 'XOM', 'CVX',
  'CAT', 'BA', 'GE', 'HON',
];

function getJson(url, headers) {
  return new Promise((resolve) => {
    const req = https.request(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', Accept: 'application/json,*/*', ...(headers || {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(9000, () => req.destroy());
    req.end();
  });
}
const iso = (mdy) => { const [m, d, y] = mdy.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };

async function earningsEvents(sym) {
  const r = await getJson(`https://api.nasdaq.com/api/company/${sym}/earnings-surprise`, { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  const rows = r.json && r.json.data && r.json.data.earningsSurpriseTable && r.json.data.earningsSurpriseTable.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((x) => ({ date: iso(x.dateReported), surprisePct: parseFloat(x.percentageSurprise) }))
    .filter((e) => e.date && Number.isFinite(e.surprisePct));
}
async function dailyAdjClose(sym) {
  return new Promise((resolve) => {
    https.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5y`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        try {
          const r = JSON.parse(d).chart.result[0];
          const ts = r.timestamp || [], adj = r.indicators.adjclose[0].adjclose;
          const arr = [];
          for (let i = 0; i < ts.length; i++) if (adj[i] != null) arr.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), px: +adj[i] });
          resolve(arr);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}
function sd(a) { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function sharpeCI(rets) {
  const T = rets.length; if (T < 3) return { sharpe: 0, lo: 0, hi: 0 };
  const m = rets.reduce((s, x) => s + x, 0) / T, s = sd(rets), per = s > 0 ? m / s : 0;
  const se = Math.sqrt((1 + (per * per) / 2) / T), k = Math.sqrt(TRADING_DAYS);
  return { sharpe: per * k, lo: (per - 1.96 * se) * k, hi: (per + 1.96 * se) * k };
}
function tstat(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; return m / (sd(a) / Math.sqrt(a.length)); }
function maxDD(eq) { let p = -Infinity, m = 0; for (const e of eq) { if (e > p) p = e; const dd = e / p - 1; if (dd < m) m = dd; } return m; }
const pct = (x) => (x * 100).toFixed(2) + '%';

(async () => {
  process.stdout.write(`Fetching earnings surprises (Nasdaq) + prices (Yahoo) for ${STOCKS.length} names...\n`);
  const px = {}, ev = {};
  let okNames = [];
  for (const s of STOCKS) {
    const [e, p] = await Promise.all([earningsEvents(s), dailyAdjClose(s)]);
    if (e.length && p.length) { ev[s] = e; px[s] = p; okNames.push(s); }
  }
  console.log(`  got earnings + prices for ${okNames.length}/${STOCKS.length} names\n`);
  if (okNames.length < 8) { console.error('too few names'); process.exit(1); }

  // index price by date for each name; helper: first trading index on/after a date
  const idxByName = {};
  for (const s of okNames) { const map = new Map(px[s].map((b, i) => [b.date, i])); idxByName[s] = { arr: px[s], map }; }
  function entryIndex(s, date) {
    const { arr } = idxByName[s];
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].date >= date) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  // ── EVENT STUDY: avg forward return after BEATS vs MISSES ──
  const beat = {}, miss = {};
  for (const h of HOLD) { beat[h] = []; miss[h] = []; }
  let nEvents = 0;
  const allEvents = []; // {s, entry, surprisePct}
  for (const s of okNames) {
    for (const e of ev[s]) {
      const ei = entryIndex(s, e.date);
      if (ei < 0) continue;
      const { arr } = idxByName[s];
      if (ei + Math.max(...HOLD) >= arr.length) continue; // need forward bars
      nEvents++;
      allEvents.push({ s, entry: ei, surprisePct: e.surprisePct });
      for (const h of HOLD) {
        const fwd = arr[ei + h].px / arr[ei].px - 1;
        (e.surprisePct >= 0 ? beat : miss)[h].push(fwd);
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`EVENT STUDY — ${nEvents} earnings events (beats vs misses), forward drift:\n`);
  console.log('  horizon   beats(n)  avg drift    misses(n) avg drift    long-short  t-stat');
  for (const h of HOLD) {
    const ls = beat[h].map((x, i) => x).concat(miss[h].map((x) => -x)); // long beats, short misses
    console.log(`  +${String(h).padEnd(3)}d     ${String(beat[h].length).padStart(6)}   ${pct(mean(beat[h])).padStart(9)}    ${String(miss[h].length).padStart(6)}  ${pct(mean(miss[h])).padStart(9)}    ${pct(mean(beat[h]) - mean(miss[h])).padStart(9)}   ${tstat(ls).toFixed(2)}`);
  }

  // ── SLEEVE BACKTEST: long beats / short misses, hold H days, market-neutral ──
  // Build a common trading-day axis from any name's price dates (use the longest).
  const axis = px[okNames[0]].map((b) => b.date);
  const dateSet = new Set(axis);
  for (const s of okNames) for (const b of px[s]) dateSet.add(b.date);
  const days = [...dateSet].sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  // each event → position on name s, sign=sign(surprise), live for entry..entry+H (in that name's own index)
  // convert to calendar-day windows
  const pos = []; // {s, startDay, endDay, sign}
  for (const e of allEvents) {
    const { arr } = idxByName[e.s];
    const startDate = arr[e.entry].date;
    const endDate = arr[Math.min(e.entry + H, arr.length - 1)].date;
    pos.push({ s: e.s, start: dayIdx.get(startDate), end: dayIdx.get(endDate), sign: Math.sign(e.surprisePct) || 1 });
  }
  const retOnDay = (s, di) => {
    const { arr, map } = idxByName[s];
    const d0 = days[di - 1], d1 = days[di];
    if (map.has(d0) && map.has(d1)) return arr[map.get(d1)].px / arr[map.get(d0)].px - 1;
    return 0;
  };
  const cost = COST_BPS / 10000;
  let prevW = {};
  const sleeveR = [], eq = [1];
  const firstDay = Math.min(...pos.map((p) => p.start));
  const lastDay = Math.max(...pos.map((p) => p.end));
  for (let di = firstDay + 1; di <= lastDay; di++) {
    const active = pos.filter((p) => p.start <= di - 1 && di - 1 <= p.end);
    const w = {};
    if (active.length) { const gw = 1 / active.length; for (const p of active) w[p.s] = (w[p.s] || 0) + p.sign * gw; }
    let pnl = 0;
    for (const s of Object.keys(prevW)) pnl += prevW[s] * retOnDay(s, di);
    let tover = 0;
    const allS = new Set([...Object.keys(w), ...Object.keys(prevW)]);
    for (const s of allS) tover += Math.abs((w[s] || 0) - (prevW[s] || 0));
    pnl -= cost * tover;
    sleeveR.push(pnl);
    eq.push(eq[eq.length - 1] * (1 + pnl));
    prevW = w;
  }
  const ci = sharpeCI(sleeveR), mdd = maxDD(eq);
  console.log(`\nSLEEVE — long beats / short misses, hold ${H}d, ${COST_BPS}bps/turnover:`);
  console.log(`  active days: ${sleeveR.length} (~${(sleeveR.length / TRADING_DAYS).toFixed(1)}y window)   total return ${pct(eq[eq.length - 1] - 1)}`);
  console.log(`  Sharpe ${ci.sharpe.toFixed(2)}  CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]   maxDD ${pct(mdd)}`);

  const passEdge = ci.lo > 0;
  console.log(`\n  ADMISSION GATE (edge condition): standalone Sharpe CI ${passEdge ? 'EXCLUDES 0 → PASS' : 'spans 0 → FAIL'}`);
  console.log(`  VERDICT: ${passEdge
    ? 'Edge is significant on real earnings events — promote to a full 10y test with a keyed API, then admit to COMBO4.'
    : 'Edge not significant over this ~1y window. The EVENT STUDY drift/t-stat is the signal to watch; extend to 10y (keyed API) before admitting.'}`);
  console.log(`\n  NOTE: ~1y window (Nasdaq gives 4 quarters keyless). Event-study t-stats above are the`);
  console.log(`  robust read; the daily sleeve Sharpe is noisy at this length. Keyed API → 10y → tight CIs.\n`);
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
