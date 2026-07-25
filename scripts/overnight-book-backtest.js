'use strict';
/**
 * overnight-book-backtest.js — backtest the PRODUCTION overnight book by driving
 * the shipped engine's own pure gates (lib/overnight-trader.js selectSleeves):
 * 4 uptrend+vol LONG sleeves (SPY/QQQ/IWM/GLD), 2 capitulation sleeves (SPY/QQQ),
 * and the reverse-ETF bear-rally fade (SH). Entry at close Mon–Thu, exit next
 * open, equity × allocPct/„k sleeves" per leg — exactly the live sizing.
 *
 * Data: data/research-corpus/prices/*.json ({dates, o, c} split-adjusted Yahoo).
 * Costs: Alpaca is commission-free; a conservative 2bp round-trip slippage is
 * charged per leg. Run: node scripts/overnight-book-backtest.js
 */
const fs = require('fs');
const path = require('path');
const { selectSleeves } = require('../apps/lantern-garage/lib/overnight-trader.js');

const ROOT = path.join(__dirname, '..');
const PRICES = path.join(ROOT, 'data', 'research-corpus', 'prices');
const ALLOC = 0.30;            // engine default OVERNIGHT_ALLOC_PCT=30
const SLIP = 0.0002;           // 2bp round trip per leg (no commissions on Alpaca)
const WARMUP = 90;             // bars each gate needs (sma50 + vol history ≤ 72)

function load(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(PRICES, sym.toLowerCase() + '.json'), 'utf8'));
  const byDate = new Map();
  for (let i = 0; i < d.dates.length; i++) byDate.set(d.dates[i], { o: d.o[i], c: d.c[i] });
  return { dates: d.dates, byDate };
}
const SYMS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SH'];
const px = Object.fromEntries(SYMS.map((s) => [s, load(s)]));

// Trade on SPY's calendar. Each symbol contributes its own close-history window.
const cal = px.SPY.dates;
const idx = Object.fromEntries(SYMS.map((s) => [s, new Map(px[s].dates.map((d, i) => [d, i]))]));

const start = cal.findIndex((d) => d >= '2006-10-01'); // SH inception + warmup
const perSleeve = {}; // sleeve|symbol → [net returns]
const daily = [];     // book daily return (0 on flat nights) aligned to cal
const spyBH = [];     // SPY close→close for the benchmark
let nightsIn = 0;

for (let t = Math.max(start, WARMUP); t < cal.length - 1; t++) {
  const date = cal[t];
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  spyBH.push(px.SPY.byDate.get(cal[t + 1]).c / px.SPY.byDate.get(date).c - 1);
  if (dow < 1 || dow > 4) { daily.push(0); continue; }   // engine enters Mon–Thu only

  // Build each symbol's own close window ending at (or before) this date.
  const closesBySym = {};
  for (const s of SYMS) {
    const i = idx[s].get(date);
    if (i == null || i < WARMUP) continue;
    const w = [];
    for (let j = i - WARMUP; j <= i; j++) w.push(px[s].byDate.get(px[s].dates[j]).c);
    closesBySym[s] = w;
  }
  const sleeves = selectSleeves(closesBySym);
  if (!sleeves.length) { daily.push(0); continue; }

  const per = ALLOC / sleeves.length;
  let night = 0;
  for (const leg of sleeves) {
    const s = leg.symbol;
    const i = idx[s].get(date);
    if (i == null || i + 1 >= px[s].dates.length) continue;
    const entry = px[s].byDate.get(px[s].dates[i]).c;
    const exit = px[s].byDate.get(px[s].dates[i + 1]).o;
    const r = exit / entry - 1 - SLIP;
    night += per * r;
    (perSleeve[leg.sleeve + '|' + s] ||= []).push(r);
  }
  daily.push(night);
  nightsIn++;
}

function stats(rets) {
  const n = rets.length;
  const mu = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1));
  return { n, mu, sd, t: sd > 0 ? (mu / sd) * Math.sqrt(n) : 0 };
}
function curve(rets) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const yrs = rets.length / 252;
  const s = stats(rets);
  return { cagr: eq ** (1 / yrs) - 1, sharpe: (s.mu / s.sd) * Math.sqrt(252), maxDD: dd, end: eq };
}

console.log(`window ${cal[Math.max(start, WARMUP)]} → ${cal[cal.length - 2]}  (${daily.length} days, ${nightsIn} nights in the market)`);
console.log('\nPER-SLEEVE (gross of sizing, net of 2bp slip):');
for (const k of Object.keys(perSleeve).sort()) {
  const s = stats(perSleeve[k]);
  console.log(`  ${k.padEnd(32)} n=${String(s.n).padStart(5)}  avg=${(s.mu * 1e4).toFixed(1).padStart(6)}bp/night  t=${s.t.toFixed(2)}`);
}
const book = curve(daily);
const spy = curve(spyBH);
console.log('\nBOOK (30% alloc split across active sleeves, rest cash@0):');
console.log(`  CAGR ${(book.cagr * 100).toFixed(2)}%  Sharpe ${book.sharpe.toFixed(2)}  maxDD ${(book.maxDD * 100).toFixed(1)}%  growth ${book.end.toFixed(2)}x`);
console.log(`  SPY buy&hold same window: CAGR ${(spy.cagr * 100).toFixed(2)}%  Sharpe ${spy.sharpe.toFixed(2)}  maxDD ${(spy.maxDD * 100).toFixed(1)}%  growth ${spy.end.toFixed(2)}x`);
// Recent sub-windows — regime robustness.
for (const from of ['2015-01-01', '2020-01-01', '2024-01-01']) {
  const cut = cal.slice(Math.max(start, WARMUP), cal.length - 1).findIndex((d) => d >= from);
  if (cut < 0) continue;
  const b = curve(daily.slice(cut)), s2 = curve(spyBH.slice(cut));
  console.log(`  since ${from.slice(0, 4)}: book CAGR ${(b.cagr * 100).toFixed(2)}% Sharpe ${b.sharpe.toFixed(2)} DD ${(b.maxDD * 100).toFixed(1)}%  |  SPY ${(s2.cagr * 100).toFixed(2)}% / ${s2.sharpe.toFixed(2)} / ${(s2.maxDD * 100).toFixed(1)}%`);
}
