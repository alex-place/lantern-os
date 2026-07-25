'use strict';
/**
 * overnight-leverage-backtest.js — PROFITABILITY pass on the production overnight
 * book: identical signals (the shipped lib/overnight-trader.js gates), different
 * EXECUTION instruments:
 *   base : SPY QQQ IWM GLD / SH
 *   2x   : SSO QLD (IWM/GLD stay 1x — no 2x data) / SH
 *   3x   : UPRO TQQQ TNA (GLD stays 1x) / SPXS for the fade
 *   synthL: synthetic margin leverage on the base book — L*r − (L−1)*(DFF+1.5%)/252
 *           (an IBKR-Pro-like financed overlay; the futures-equivalent cost model)
 * Real leveraged-ETF prices carry their own financing/decay — nothing synthetic.
 * Window starts 2010-02 (TQQQ inception + warmup) so every variant sees the SAME days.
 * Run: node scripts/overnight-leverage-backtest.js
 */
const fs = require('fs');
const path = require('path');
const { selectSleeves } = require('../apps/lantern-garage/lib/overnight-trader.js');

const ROOT = path.join(__dirname, '..');
const PRICES = path.join(ROOT, 'data', 'research-corpus', 'prices');
const SLIP = 0.0002;
const WARMUP = 90;
const START = '2010-03-01';

function load(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(PRICES, sym.toLowerCase() + '.json'), 'utf8'));
  const byDate = new Map();
  for (let i = 0; i < d.dates.length; i++) if (d.o[i] > 0 && d.c[i] > 0) byDate.set(d.dates[i], { o: d.o[i], c: d.c[i] });
  const dates = [...byDate.keys()];
  return { dates, byDate, idx: new Map(dates.map((x, i) => [x, i])) };
}
const SIG = ['SPY', 'QQQ', 'IWM', 'GLD', 'SH'];
const EXEC = ['SSO', 'QLD', 'UPRO', 'TQQQ', 'TNA', 'SPXS'];
const px = Object.fromEntries([...SIG, ...EXEC].map((s) => [s, load(s)]));

// DFF (daily fed funds) → date-keyed decimal
const dff = new Map();
for (const line of fs.readFileSync(path.join(PRICES, 'dff.csv'), 'utf8').split('\n').slice(1)) {
  const [d, v] = line.trim().split(',');
  if (d && v) dff.set(d, Number(v) / 100);
}
let _lastDff = 0.02;
function dffAt(date) { const v = dff.get(date); if (v != null) _lastDff = v; return _lastDff; }

const MAPS = {
  base: {},
  x2: { SPY: 'SSO', QQQ: 'QLD' },
  x3: { SPY: 'UPRO', QQQ: 'TQQQ', IWM: 'TNA', SH: 'SPXS' },
};

const cal = px.SPY.dates;
const t0 = Math.max(cal.findIndex((d) => d >= START), WARMUP);
const out = { base: [], x2: [], x3: [], syn2: [], syn3: [] };
const spyBH = [];

for (let t = t0; t < cal.length - 1; t++) {
  const date = cal[t];
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  spyBH.push(px.SPY.byDate.get(cal[t + 1]).c / px.SPY.byDate.get(date).c - 1);
  if (dow < 1 || dow > 4) { for (const k of Object.keys(out)) out[k].push(0); continue; }

  const closesBySym = {};
  for (const s of SIG) {
    const i = px[s].idx.get(date);
    if (i == null || i < WARMUP) continue;
    const w = [];
    for (let j = i - WARMUP; j <= i; j++) w.push(px[s].byDate.get(px[s].dates[j]).c);
    closesBySym[s] = w;
  }
  const sleeves = selectSleeves(closesBySym);
  if (!sleeves.length) { for (const k of Object.keys(out)) out[k].push(0); continue; }
  const per = 1 / sleeves.length;   // 100% deployed across tonight's sleeves

  const legRet = (execSym) => {
    const p = px[execSym];
    const i = p.idx.get(date);
    if (i == null || i + 1 >= p.dates.length) return null;
    return p.byDate.get(p.dates[i + 1]).o / p.byDate.get(p.dates[i]).c - 1 - SLIP;
  };

  for (const [variant, map] of Object.entries(MAPS)) {
    let night = 0;
    for (const leg of sleeves) {
      const r = legRet(map[leg.symbol] || leg.symbol);
      if (r != null) night += per * r;
    }
    out[variant].push(night);
  }
  // Synthetic margin leverage on the BASE night (financing on the borrowed L−1,
  // charged for the 1 calendar night ≈ 1/365 of the annual rate).
  const baseNight = out.base[out.base.length - 1];
  const fin = (dffAt(date) + 0.015) / 365;
  out.syn2.push(2 * baseNight - 1 * fin);
  out.syn3.push(3 * baseNight - 2 * fin);
}

function curve(rets) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const n = rets.length, mu = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
  return { cagr: eq ** (252 / n) - 1, sharpe: (mu / sd) * Math.sqrt(252), maxDD: dd, end: eq };
}
const rows = [['variant', 'CAGR', 'Sharpe', 'maxDD', 'growth']];
const label = { base: 'base 1x (SPY/QQQ/IWM/GLD/SH)', x2: '2x ETFs (SSO/QLD)', x3: '3x ETFs (UPRO/TQQQ/TNA/SPXS)', syn2: 'synthetic 2x margin (DFF+1.5%)', syn3: 'synthetic 3x margin (DFF+1.5%)' };
for (const k of ['base', 'x2', 'x3', 'syn2', 'syn3']) {
  const c = curve(out[k]);
  rows.push([label[k], (c.cagr * 100).toFixed(1) + '%', c.sharpe.toFixed(2), (c.maxDD * 100).toFixed(1) + '%', c.end.toFixed(1) + 'x']);
}
const s = curve(spyBH);
rows.push(['SPY buy & hold', (s.cagr * 100).toFixed(1) + '%', s.sharpe.toFixed(2), (s.maxDD * 100).toFixed(1) + '%', s.end.toFixed(1) + 'x']);
console.log(`window ${cal[t0]} → ${cal[cal.length - 2]}  (100% deployed across active sleeves)`);
for (const r of rows) console.log('  ' + r.map((x, i) => String(x).padEnd(i ? 8 : 34)).join(''));
// Recent windows for the levered variants
for (const from of ['2020-01-01', '2024-01-01']) {
  const cut = cal.slice(t0, cal.length - 1).findIndex((d) => d >= from);
  console.log(`  since ${from.slice(0, 4)}:`);
  for (const k of ['base', 'x3', 'syn3']) {
    const c = curve(out[k].slice(cut));
    console.log(`    ${label[k].padEnd(32)} CAGR ${(c.cagr * 100).toFixed(1)}%  Sharpe ${c.sharpe.toFixed(2)}  maxDD ${(c.maxDD * 100).toFixed(1)}%`);
  }
  const c = curve(spyBH.slice(cut));
  console.log(`    ${'SPY buy & hold'.padEnd(32)} CAGR ${(c.cagr * 100).toFixed(1)}%  Sharpe ${c.sharpe.toFixed(2)}  maxDD ${(c.maxDD * 100).toFixed(1)}%`);
}
