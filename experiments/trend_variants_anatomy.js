'use strict';
/**
 * trend_variants_anatomy.js — CAN THE TREND-DAY ENTRY TRADE A RALLY WITH NO DIP BETTER?
 * (ledger row soxl-trend-variants-rally-days, 2026-09-30).
 *
 * The candidate (V0) enters at 10:30 at the earliest, after the move is visible. Four pre-declared
 * changes, measured on the same 5m bar caches the harness reads, nothing replayed:
 *
 *   V0  first of the bars closing 10:30 / 11:30 / 13:00 at which the name sits in the top fifth of its
 *       session range AND the range is at least its median absolute daily move (60 prior sessions);
 *       entry at that bar's close; 8% stop under the entry; out at the 15:50 bar's close
 *   V1  V0 plus a checkpoint at the bar closing 10:00
 *   V2  any 5m bar closing from 10:00 to 13:00 that meets the rule (the first one fires)
 *   V3  V0's entries with a trailing stop 3% under the highest close since entry
 *   V4  V3 at 2%
 *
 * Stops: the level is triggered by a later bar's low and fills at the level, or at the close of a bar
 * that sits wholly under it (the pessimistic convention of REPLAY_GAP_FILL=close).
 * Bars are keyed by their START minute; "the bar closing 10:30" starts at 10:25 (minute 625).
 *
 * Usage: node experiments/trend_variants_anatomy.js [--syms SOXL] [--wins scored|map] [--json out.json]
 *   caches: <os.tmpdir()>/oos_<window> (CACHE_ROOT overrides)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SYMS = String(flag('--syms') || 'SOXL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const MAP30 = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort();
const SURFACES = flag('--wins') === 'map' ? { map: MAP30 } : flag('--wins') === 'scored' ? { scored: SCORED13 } : { scored: SCORED13, map: MAP30 };
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);
const TOP = 0.8, RANGE_K = 1.0, HARD_STOP = 0.08, SALE_MIN = 950, MIN_N = 5;

const VARIANTS = {
  V0: { checks: [625, 685, 775], trail: 0 },
  V1: { checks: [595, 625, 685, 775], trail: 0 },
  V2: { checks: Array.from({ length: (775 - 595) / 5 + 1 }, (_, i) => 595 + 5 * i), trail: 0 },
  V3: { checks: [625, 685, 775], trail: 0.03 },
  V4: { checks: [625, 685, 775], trail: 0.02 },
};

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
function mad60(s, i, sym) {
  if (i < 61) return null;
  const a = [];
  for (let k = i - 60; k < i; k++) { const r = s.close[k] / s.close[k - 1] - 1; if (Math.abs(r) > (LEV.has(sym) ? 0.6 : 0.3)) return null; a.push(Math.abs(r)); }
  a.sort((x, y) => x - y);
  return (a[29] + a[30]) / 2;
}
/** One session under one variant: null (no entry) or { at, entry, exit, ret, how } */
function session(bars, mad, v) {
  let hi = -Infinity, lo = Infinity, ent = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    if (!ent && v.checks.includes(b.min) && hi > lo && (b.c - lo) / (hi - lo) >= TOP && (hi - lo) / lo >= RANGE_K * mad) { ent = { i, px: b.c, at: b.min + 5 }; break; }
  }
  if (!ent) return null;
  const hard = ent.px * (1 - HARD_STOP);
  let best = ent.px;
  for (let j = ent.i + 1; j < bars.length; j++) {
    const b = bars[j];
    const lvl = Math.max(hard, v.trail > 0 ? best * (1 - v.trail) : 0);
    if (b.l <= lvl) { const px = b.h < lvl ? b.c : lvl; return { at: ent.at, entry: ent.px, exit: px, ret: px / ent.px - 1, how: lvl > hard ? 'trail' : 'stop' }; }
    if (b.min >= SALE_MIN) return { at: ent.at, entry: ent.px, exit: b.c, ret: b.c / ent.px - 1, how: 'close' };
    best = Math.max(best, b.c);
  }
  const last = bars[bars.length - 1];
  return { at: ent.at, entry: ent.px, exit: last.c, ret: last.c / ent.px - 1, how: 'close' };
}

const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const results = {};
for (const [surface, wins] of Object.entries(SURFACES)) {
  results[surface] = {};
  console.log(`\n=== ${surface === 'scored' ? '13 scored windows' : '30 unseen quarters'} | ${SYMS.join(',')}`);
  console.log('| variant | entries | mean per entry | sum of returns | gain | mean gain | mean loss | quarters + / - (>=5 entries) | exits |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [vn, v] of Object.entries(VARIANTS)) {
    const all = []; let pos = 0, neg = 0;
    for (const w of wins) {
      const q = [];
      for (const sym of SYMS) {
        const s = load(sym);
        for (const day of windowDays(w)) {
          const i = s.idx.get(day); if (i == null) continue;
          const bars = s.sessions.get(day); if (!bars || bars.length < 60) continue;
          const mad = mad60(s, i, sym); if (!(mad > 0)) continue;
          const r = session(bars, mad, v); if (r) q.push({ ...r, sym, day, win: w });
        }
      }
      if (q.length >= MIN_N) { const m = q.reduce((a, x) => a + x.ret, 0) / q.length; if (m > 0.0002) pos++; else if (m < -0.0002) neg++; }
      all.push(...q);
    }
    const n = all.length, sum = all.reduce((a, x) => a + x.ret, 0);
    const g = all.filter((x) => x.ret > 0), l = all.filter((x) => x.ret <= 0);
    const how = {}; for (const x of all) how[x.how] = (how[x.how] || 0) + 1;
    results[surface][vn] = { n, mean: n ? sum / n : null, sum, pos, neg, how };
    console.log(`| ${vn} | ${n} | ${pct(n ? sum / n : null)} | ${pct(sum, 1)} | ${pct(n ? g.length / n : null, 0)} | ${pct(g.length ? g.reduce((a, x) => a + x.ret, 0) / g.length : null, 2)} | ${pct(l.length ? l.reduce((a, x) => a + x.ret, 0) / l.length : null, 2)} | ${pos} / ${neg} | ${Object.entries(how).map(([k, c]) => k + ' ' + c).join(', ')} |`);
  }
}
if (Object.keys(results).length === 2) {
  const base = { s: results.scored.V0, m: results.map.V0 };
  console.log('\nBAR to replace V0: higher mean AND higher sum on both surfaces, positive quarters >= V0 on both');
  for (const vn of ['V1', 'V2', 'V3', 'V4']) {
    const s = results.scored[vn], m = results.map[vn];
    const ok = s.mean > base.s.mean && m.mean > base.m.mean && s.sum > base.s.sum && m.sum > base.m.sum && s.pos >= base.s.pos && m.pos >= base.m.pos;
    console.log(`  ${vn}: ${ok ? 'CLEARS' : 'does not clear'} (mean ${pct(s.mean)} / ${pct(m.mean)} against ${pct(base.s.mean)} / ${pct(base.m.mean)}; sum ${pct(s.sum, 1)} / ${pct(m.sum, 1)} against ${pct(base.s.sum, 1)} / ${pct(base.m.sum, 1)}; quarters up ${s.pos} / ${m.pos} against ${base.s.pos} / ${base.m.pos})`);
  }
}
const out = flag('--json');
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
