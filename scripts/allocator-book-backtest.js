'use strict';
/**
 * allocator-book-backtest.js — WALK-FORWARD backtest of the COMBINED trader:
 * the capital allocator (lib/capital-allocator.js allocate(), the shipped math)
 * sizing the overnight sleeve book (lib/overnight-trader.js gates, 3x execution)
 * night by night, using ONLY the evidence a live ledger would have had by then.
 *
 * Honesty notes:
 *  - intraday + options sleeves contribute 0 return (no proven live edge to
 *    simulate — modeling them as profitable would be fiction). Their floors
 *    still consume budget, exactly as live.
 *  - the allocator starts with an EMPTY ledger → overnight sits at its 5%
 *    exploration floor until n≥20 nights accumulate, then Kelly-lite growth
 *    under the 60% cap. No lookahead anywhere: night t is sized by nights <t.
 * Run: node scripts/allocator-book-backtest.js
 */
const fs = require('fs');
const path = require('path');
const { selectSleeves } = require('../apps/lantern-garage/lib/overnight-trader.js');
const { allocate } = require('../apps/lantern-garage/lib/capital-allocator.js');

const PRICES = path.join(__dirname, '..', 'data', 'research-corpus', 'prices');
const SLIP = 0.0002, WARMUP = 90, START = '2010-03-01';
const EXEC = { SPY: 'UPRO', QQQ: 'TQQQ', IWM: 'TNA', SH: 'SPXS' };   // 3x tier

function load(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(PRICES, sym.toLowerCase() + '.json'), 'utf8'));
  const byDate = new Map();
  for (let i = 0; i < d.dates.length; i++) if (d.o[i] > 0 && d.c[i] > 0) byDate.set(d.dates[i], { o: d.o[i], c: d.c[i] });
  const dates = [...byDate.keys()];
  return { dates, byDate, idx: new Map(dates.map((x, i) => [x, i])) };
}
const SYMS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SH', 'UPRO', 'TQQQ', 'TNA', 'SPXS'];
const px = Object.fromEntries(SYMS.map((s) => [s, load(s)]));
const cal = px.SPY.dates;
const t0 = Math.max(cal.findIndex((d) => d >= START), WARMUP);

const ledger = [];          // realized per-night book-sleeve returns, as the live ledger would hold
const daily = [], allocs = [], spyBH = [];
function mvs(rets) {
  const n = rets.length;
  if (!n) return { n: 0, avg: 0, sd: 0 };
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1)) || 0;
  return { n, avg, sd };
}

for (let t = t0; t < cal.length - 1; t++) {
  const date = cal[t];
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  spyBH.push(px.SPY.byDate.get(cal[t + 1]).c / px.SPY.byDate.get(date).c - 1);
  // Tonight's budget from ONLY past evidence (walk-forward).
  const a = allocate({ equity: 1, evidence: { overnight: mvs(ledger) } });
  const pct = a.sleeves.overnight.pct / 100;
  allocs.push(pct);
  if (dow < 1 || dow > 4) { daily.push(0); continue; }

  const closesBySym = {};
  for (const s of ['SPY', 'QQQ', 'IWM', 'GLD', 'SH']) {
    const i = px[s].idx.get(date);
    if (i == null || i < WARMUP) continue;
    const w = [];
    for (let j = i - WARMUP; j <= i; j++) w.push(px[s].byDate.get(px[s].dates[j]).c);
    closesBySym[s] = w;
  }
  const sleeves = selectSleeves(closesBySym);
  if (!sleeves.length) { daily.push(0); continue; }
  const per = 1 / sleeves.length;
  let night = 0;
  for (const leg of sleeves) {
    const ex = EXEC[leg.symbol] || leg.symbol;
    const p = px[ex]; const i = p.idx.get(date);
    if (i == null || i + 1 >= p.dates.length) continue;
    night += per * (p.byDate.get(p.dates[i + 1]).o / p.byDate.get(p.dates[i]).c - 1 - SLIP);
  }
  ledger.push(night);              // the sleeve's realized night joins the evidence
  daily.push(pct * night);         // the BOOK earns allocation × sleeve return
}

function curve(rets) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const s = mvs(rets);
  return { cagr: eq ** (252 / rets.length) - 1, sharpe: (s.avg / s.sd) * Math.sqrt(252), maxDD: dd, end: eq };
}
const book = curve(daily);
const spy = curve(spyBH);
// static comparisons on the same sleeve stream (divide out the walk-forward pct):
const alloc30 = curve(daily.map((d, i) => allocs[i] > 0 ? (d / allocs[i]) * 0.30 : 0));
const alloc100 = curve(daily.map((d, i) => allocs[i] > 0 ? (d / allocs[i]) : 0));
console.log(`window ${cal[t0]} → ${cal[cal.length - 2]}  (walk-forward: night t sized by nights <t only)`);
console.log(`  allocation path: floor 5% for the first ~20 in-market nights → grew to ${(allocs[allocs.length - 1] * 100).toFixed(0)}% (cap 60); mean ${(allocs.reduce((a, b) => a + b, 0) / allocs.length * 100).toFixed(1)}%`);
console.log(`  ALLOCATOR BOOK: CAGR ${(book.cagr * 100).toFixed(1)}%  Sharpe ${book.sharpe.toFixed(2)}  maxDD ${(book.maxDD * 100).toFixed(1)}%  growth ${book.end.toFixed(1)}x`);
console.log(`  static 30% alloc: CAGR ${(alloc30.cagr * 100).toFixed(1)}%  Sharpe ${alloc30.sharpe.toFixed(2)}  maxDD ${(alloc30.maxDD * 100).toFixed(1)}%`);
console.log(`  static 100% alloc: CAGR ${(alloc100.cagr * 100).toFixed(1)}%  Sharpe ${alloc100.sharpe.toFixed(2)}  maxDD ${(alloc100.maxDD * 100).toFixed(1)}%`);
console.log(`  SPY buy & hold:  CAGR ${(spy.cagr * 100).toFixed(1)}%  Sharpe ${spy.sharpe.toFixed(2)}  maxDD ${(spy.maxDD * 100).toFixed(1)}%`);
