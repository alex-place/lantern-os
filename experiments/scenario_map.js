'use strict';
/**
 * scenario_map.js — WHERE DOES THE BOOK EARN AND LOSE, BY THE MARKET'S DAY TYPE?
 * (ledger row scenario-map-book-coverage, 2026-09-30).
 *
 * Each session is classified from SPY's regular-session 5m bars against its own scale (mad = the median
 * absolute daily move over the 60 prior sessions; range = (high - low) / low; CL = where the close sits in
 * the range):
 *   NARROW  range < mad
 *   RALLY   CL >= 0.75 and the low came before 11:00      DROP   CL <= 0.25 and the high came before 11:00
 *   V_UP    CL >= 0.6 and the low came at or after 11:00   FADE   CL <= 0.4 and the high came at or after 11:00
 *   MIXED   the other wide days
 * The book's trades (harness dumps) are attributed to their entry day's type, and to two regimes known at
 * the open: SPY above/below the mean of its last 200 closes, and its 20-session realized volatility
 * above/below 16% annualized. The "prize" of a type = SPY's average absolute move from 10:30 to the close.
 *
 * Usage: node experiments/scenario_map.js <dumpDir> <prefix> <variant> [--wins a,b|map] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [DIR, PREFIX, VAR] = positional;
if (!DIR || !PREFIX || !VAR) { console.error('usage: node scenario_map.js <dumpDir> <prefix> <variant> [--wins a,b|map] [--json out.json]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const W = flag('--wins');
const WINS = !W ? SCORED13 : W === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort() : W.split(',');
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const memo = new Map();
function et(ms) { let e = memo.get(ms); if (e) return e; const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value; e = { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) }; memo.set(ms, e); return e; }
const dirs = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_/.test(d));
function loadSessions(sym) {
  const byT = new Map();
  for (const d of dirs) { const f = path.join(CACHE_ROOT, d, sym + '.json'); if (!fs.existsSync(f)) continue; let bars; try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { continue; } for (const b of bars) { const e = et(b.t); if (e.min < 570 || e.min >= 960) continue; if (!byT.has(b.t)) byT.set(b.t, { t: b.t, c: +b.c, h: +b.h, l: +b.l, day: e.day, min: e.min }); } }
  const sessions = new Map();
  for (const b of [...byT.values()].sort((a, b) => a.t - b.t)) { if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); }
  const days = [...sessions.keys()].sort();
  return { sessions, days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => { const a = sessions.get(d); return a[a.length - 1].c; }) };
}
const SPY = loadSessions('SPY');
function classify(day) {
  const i = SPY.idx.get(day); if (i == null || i < 61) return null;
  const bars = SPY.sessions.get(day); if (!bars || bars.length < 60) return null;
  const a = []; for (let k = i - 60; k < i; k++) a.push(Math.abs(SPY.close[k] / SPY.close[k - 1] - 1)); a.sort((x, y) => x - y);
  const mad = (a[29] + a[30]) / 2;
  let hi = -Infinity, lo = Infinity, hiMin = 0, loMin = 0;
  for (const b of bars) { if (b.h > hi) { hi = b.h; hiMin = b.min; } if (b.l < lo) { lo = b.l; loMin = b.min; } }
  const close = bars[bars.length - 1].c, range = (hi - lo) / lo, cl = (close - lo) / (hi - lo);
  let type;
  if (range < mad) type = 'NARROW';
  else if (cl >= 0.75 && loMin < 660) type = 'RALLY';
  else if (cl <= 0.25 && hiMin < 660) type = 'DROP';
  else if (cl >= 0.6 && loMin >= 660) type = 'V_UP';
  else if (cl <= 0.4 && hiMin >= 660) type = 'FADE';
  else type = 'MIXED';
  const at1030 = bars.find((b) => b.min === 625);
  const prize = at1030 ? Math.abs(close / at1030.c - 1) : null;
  // regimes known at the open
  let r200 = null; if (i >= 200) { let s = 0; for (let k = i - 200; k < i; k++) s += SPY.close[k]; r200 = SPY.close[i - 1] > s / 200; }
  const rets = []; for (let k = i - 20; k < i; k++) rets.push(Math.log(SPY.close[k] / SPY.close[k - 1]));
  const m = rets.reduce((x, y) => x + y, 0) / rets.length; const vol = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1) * 252);
  return { type, prize, r200, hiVol: vol >= 0.16 };
}
const TYPES = ['RALLY', 'DROP', 'V_UP', 'FADE', 'MIXED', 'NARROW'];
const days = new Map();           // day -> classification
const trades = [];
for (const w of WINS) {
  const f = path.join(DIR, `${PREFIX}_${w}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const b of JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, 'oos_' + w, 'SPY.json'), 'utf8'))) { const e = et(b.t); if (e.min >= 570 && e.min < 960 && !days.has(e.day)) days.set(e.day, classify(e.day)); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) { if (t.owner !== 'S') continue; const d = et(t.entry_ms).day; const c = days.get(d) || classify(d); if (!c) continue; trades.push({ ...t, win: w, day: d, ...c }); }
}
const cls = [...days.values()].filter(Boolean);
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const total = trades.reduce((a, t) => a + t.pnl, 0);
console.log(`${WINS.length} windows | ${cls.length} sessions classified | ${trades.length} book trades | book ${usd(total)}`);
console.log('| day type | sessions | share | SPY move 10:30->close (abs, mean) | book trades | trades per session | book P&L | per trade | share of the book |');
console.log('|---|---|---|---|---|---|---|---|---|');
const out = { windows: WINS, types: {} };
const wide = cls.filter((c) => c.type !== 'NARROW').length;
for (const ty of TYPES) {
  const ds = cls.filter((c) => c.type === ty); const tr = trades.filter((t) => t.type === ty); const pnl = tr.reduce((a, t) => a + t.pnl, 0);
  const prize = ds.filter((d) => d.prize != null).map((d) => d.prize);
  out.types[ty] = { sessions: ds.length, trades: tr.length, pnl, perTrade: tr.length ? tr.reduce((a, t) => a + t.ret, 0) / tr.length : null, prize: prize.length ? prize.reduce((a, b) => a + b, 0) / prize.length : null };
  console.log(`| ${ty} | ${ds.length} | ${pct(ds.length / cls.length, 0)}${ty !== 'NARROW' ? ' (' + pct(ds.length / wide, 0) + ' of wide)' : ''} | ${pct(out.types[ty].prize)} | ${tr.length} | ${(tr.length / Math.max(1, ds.length)).toFixed(2)} | ${usd(pnl)} | ${pct(out.types[ty].perTrade)} | ${pct(total ? pnl / total : null, 0)} |`);
}
console.log('\nby regime known at the open:');
for (const [name, fn] of [['SPY above its 200-session mean', (t) => t.r200 === true], ['SPY below it', (t) => t.r200 === false], ['20-session vol >= 16%', (t) => t.hiVol], ['20-session vol < 16%', (t) => !t.hiVol]]) {
  const tr = trades.filter(fn); const pnl = tr.reduce((a, t) => a + t.pnl, 0);
  console.log(`  ${name.padEnd(32)} ${String(tr.length).padStart(5)} trades | ${usd(pnl).padStart(8)} | ${pct(tr.length ? tr.reduce((a, t) => a + t.ret, 0) / tr.length : null)} per trade`);
}
console.log('\nbook P&L by day type and regime (SPY vs its 200-session mean):');
for (const ty of TYPES) { const up = trades.filter((t) => t.type === ty && t.r200 === true), dn = trades.filter((t) => t.type === ty && t.r200 === false); console.log(`  ${ty.padEnd(7)} above ${usd(up.reduce((a, t) => a + t.pnl, 0)).padStart(8)} (${up.length}) | below ${usd(dn.reduce((a, t) => a + t.pnl, 0)).padStart(8)} (${dn.length})`); }
const o = flag('--json'); if (o) fs.writeFileSync(o, JSON.stringify(out, null, 1));
