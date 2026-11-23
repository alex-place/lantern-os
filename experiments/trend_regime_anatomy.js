'use strict';
/**
 * trend_regime_anatomy.js — KEEP EACH TREND LEG IN ITS REGIME (ledger row semis-trend-regime-gated, 2026-09-30).
 *
 * The trend-day entry (V0 of trend_variants_anatomy.js: the first of the bars closing 10:30 / 11:30 / 13:00
 * at which the name sits in the top fifth of a session range at least as wide as its median daily move;
 * 8% stop; out at 15:50) holds on SOXL; on SOXS it is positive but inconsistent, and pooling the two adds
 * return without adding consistency. This gates each leg by the semis' regime:
 *
 *   R0  SOXL + SOXS pooled, no gate (as measured)
 *   R1  SOXL only while SMH's prior close is above the mean of its last 200 closes; SOXS only while below
 *   R2  the same with 50 closes
 *
 * The regime uses closes completed before the session (no look-ahead); a day without enough history is
 * not traded by R1/R2. Nothing is replayed.
 *
 * Usage: node experiments/trend_regime_anatomy.js [--long SOXL] [--inverse SOXS] [--proxy SMH] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const LONG = String(flag('--long') || 'SOXL').toUpperCase(), INV = String(flag('--inverse') || 'SOXS').toUpperCase(), PROXY = String(flag('--proxy') || 'SMH').toUpperCase();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const MAP30 = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort();
const SURFACES = { scored: SCORED13, map: MAP30 };
const CHECKS = [625, 685, 775], TOP = 0.8, RANGE_K = 1.0, HARD_STOP = 0.08, SALE_MIN = 950, MIN_N = 5;

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const memo = new Map();
function et(ms) {
  let e = memo.get(ms); if (e) return e;
  const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
  e = { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
  memo.set(ms, e); return e;
}
const dirs = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_/.test(d));
const book = new Map();
function load(sym) {
  if (book.has(sym)) return book.get(sym);
  const byT = new Map();
  for (const d of dirs) {
    const f = path.join(CACHE_ROOT, d, sym + '.json');
    if (!fs.existsSync(f)) continue;
    let bars; try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { continue; }
    for (const b of bars) { const e = et(b.t); if (e.min < 570 || e.min >= 960) continue; if (!byT.has(b.t)) byT.set(b.t, { t: b.t, c: Number(b.c), h: Number(b.h), l: Number(b.l), day: e.day, min: e.min }); }
  }
  const sessions = new Map();
  for (const b of [...byT.values()].sort((a, b) => a.t - b.t)) { if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); }
  const days = [...sessions.keys()].sort();
  const s = { sessions, days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => { const a = sessions.get(d); return a[a.length - 1].c; }) };
  book.set(sym, s); return s;
}
function windowDays(win) {
  const set = new Set();
  for (const b of JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, 'oos_' + win, 'SPY.json'), 'utf8'))) { const e = et(b.t); if (e.min >= 570 && e.min < 960) set.add(e.day); }
  return [...set].sort();
}
function mad60(s, i) {
  if (i < 61) return null;
  const a = [];
  for (let k = i - 60; k < i; k++) { const r = s.close[k] / s.close[k - 1] - 1; if (Math.abs(r) > 0.6) return null; a.push(Math.abs(r)); }
  a.sort((x, y) => x - y); return (a[29] + a[30]) / 2;
}
/** The proxy's prior close against the mean of its last n closes: true above, false below, null without history. */
function regimeUp(day, n) {
  const s = load(PROXY); let j = s.idx.get(day);
  if (j == null) { j = s.days.findIndex((d) => d > day); if (j < 0) j = s.days.length; }
  if (j < n) return null;
  const span = (Date.parse(s.days[j - 1] + 'T00:00:00Z') - Date.parse(s.days[j - n] + 'T00:00:00Z')) / 86400000;
  if (span > n * 1.6) return null;                       // a hole in the cached history: refuse rather than guess
  let sum = 0; for (let k = j - n; k < j; k++) sum += s.close[k];
  return s.close[j - 1] > sum / n;
}
function trade(sym, day) {
  const s = load(sym); const i = s.idx.get(day); if (i == null) return null;
  const bars = s.sessions.get(day); if (!bars || bars.length < 60) return null;
  const mad = mad60(s, i); if (!(mad > 0)) return null;
  let hi = -Infinity, lo = Infinity, ent = -1;
  for (let k = 0; k < bars.length; k++) { const b = bars[k]; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); if (CHECKS.includes(b.min) && hi > lo && (b.c - lo) / (hi - lo) >= TOP && (hi - lo) / lo >= RANGE_K * mad) { ent = k; break; } }
  if (ent < 0) return null;
  const px = bars[ent].c, stop = px * (1 - HARD_STOP);
  for (let j = ent + 1; j < bars.length; j++) {
    const b = bars[j];
    if (b.l <= stop) return { ret: (b.h < stop ? b.c : stop) / px - 1, how: 'stop' };
    if (b.min >= SALE_MIN) return { ret: b.c / px - 1, how: 'close' };
  }
  return { ret: bars[bars.length - 1].c / px - 1, how: 'close' };
}
const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const results = {};
for (const [surface, wins] of Object.entries(SURFACES)) {
  results[surface] = {};
  const rows = [];
  for (const w of wins) for (const day of windowDays(w)) {
    for (const sym of [LONG, INV]) { const t = trade(sym, day); if (t) rows.push({ win: w, day, sym, ...t, r200: regimeUp(day, 200), r50: regimeUp(day, 50) }); }
  }
  const variants = {
    R0: () => true,
    R1: (r) => r.r200 != null && (r.sym === LONG ? r.r200 : !r.r200),
    R2: (r) => r.r50 != null && (r.sym === LONG ? r.r50 : !r.r50),
  };
  console.log(`\n=== ${surface === 'scored' ? '13 scored windows' : '30 unseen quarters'} | ${LONG} + ${INV}, regime by ${PROXY}`);
  console.log(`| variant | entries | ${LONG} / ${INV} | mean per entry | sum | gain | quarters + / - (>=5 entries) | worst quarter (mean) |`);
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [vn, ok] of Object.entries(variants)) {
    const a = rows.filter(ok);
    let pos = 0, neg = 0, worst = null;
    for (const w of wins) { const q = a.filter((r) => r.win === w); if (q.length >= MIN_N) { const m = q.reduce((x, r) => x + r.ret, 0) / q.length; if (m > 0.0002) pos++; else if (m < -0.0002) neg++; if (worst == null || m < worst.m) worst = { w, m }; } }
    const sum = a.reduce((x, r) => x + r.ret, 0);
    results[surface][vn] = { n: a.length, nLong: a.filter((r) => r.sym === LONG).length, nInv: a.filter((r) => r.sym === INV).length, mean: a.length ? sum / a.length : null, sum, pos, neg };
    console.log(`| ${vn} | ${a.length} | ${results[surface][vn].nLong} / ${results[surface][vn].nInv} | ${pct(a.length ? sum / a.length : null)} | ${pct(sum, 1)} | ${pct(a.length ? a.filter((r) => r.ret > 0).length / a.length : null, 0)} | ${pos} / ${neg} | ${worst ? worst.w + ' ' + pct(worst.m) : '-'} |`);
  }
}
console.log('\nIMPROVED BAR: positive in >= 9 of 13 AND >= 22 of 30, mean >= +0.15% per entry on both surfaces');
for (const vn of ['R1', 'R2']) {
  const s = results.scored[vn], m = results.map[vn];
  const ok = s.pos >= 9 && m.pos >= 22 && s.mean >= 0.0015 && m.mean >= 0.0015;
  console.log(`  ${vn}: ${ok ? 'CLEARS' : 'does not clear'} (quarters up ${s.pos} / ${m.pos}; mean ${pct(s.mean)} / ${pct(m.mean)})`);
}
const out = flag('--json');
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
