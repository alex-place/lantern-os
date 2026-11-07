'use strict';
/**
 * intraday_hold_anatomy.js — CAN THE RULES CAPTURE A TREND DAY INSIDE THE SESSION?
 * (ledger row intraday-trend-capture-13-windows, 2026-09-29).
 *
 * SOXL's week to 2026-09-29 was made by two sessions. On 09-22 (+10.4% inside the session) the name
 * opened at its low and sat at 95-99% of its range all day: the washout signal never fired. On 09-24
 * (+5.7%) stable bought the 11:16 dip and the bounce exit sold it an hour later at +1.75%, 3.4% under
 * the close. Two ways to capture such days, measured without a replay on the harness dumps and the
 * same 5m bar caches:
 *
 *   A  HOLD THE BOUNCE TO THE CLOSE  every position the bounce exit sold before 15:50 is held to the
 *      15:50 bar of that day, protected by the 3% stop under its entry (a bar wholly under the stop
 *      fills at its close). Beside it, not scored: a floor 1% under the highest 5m close since the sale.
 *   B  BUY THE TREND DAY  at the first of 10:30 / 11:30 / 13:00 ET at which a long name sits in the
 *      top fifth of its session range AND that range is at least the name's own median absolute
 *      daily move (60 prior sessions): buy that bar's close, sell the 15:50 bar's close, no stop.
 *
 * NO LOOK-AHEAD: B's scale uses sessions completed before the session; its trigger uses bars up to
 * the checkpoint. The checkpoints name the bar that CLOSES at that time.
 *
 * Usage: node experiments/intraday_hold_anatomy.js <dumpDir> [prefix=floor] [variant=F_armed] [--wins a,b|map] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const DIR = positional[0], PREFIX = positional[1] || 'floor', VAR = positional[2] || 'F_armed';
if (!DIR) { console.error('usage: node intraday_hold_anatomy.js <dumpDir> [prefix] [variant] [--wins a,b|map] [--json out.json]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const WINS_ARG = flag('--wins') || '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = { q4: 'Q4-25', q1: 'Q1-26', aprjul: 'AprJul-26', julsep: 'JulSep-26' };
const label = (w) => NAMES[w] || (/^\d\dq\d$/.test(w) ? `Q${w[3]}-${w.slice(0, 2)}` : w);
const LONGS = String(process.env.TREND_LONGS || 'SPY,QQQ,IWM,DIA,GLD,TLT,SMH,XLK,SOXL,TQQQ,TNA,SPXL,UPRO,USO,XOP,GDX,SLV,XLE,NUGT,JNUG,UCO').split(',');
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);
const STOP_PCT = 0.03, TRAIL_PCT = 0.01, SALE_MIN = 950, BAND = 50;
const CHECKS = [625, 685, 775];                             // bars that close at 10:30, 11:30, 13:00
const TOP = Number(process.env.TREND_IBS || 0.8), RANGE_K = Number(process.env.TREND_RANGE_K || 1.0);

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const memo = new Map();
function et(ms) {
  let e = memo.get(ms); if (e) return e;
  const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
  e = { day: `${g('year')}-${g('month')}-${g('day')}`, wd: g('weekday'), min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
  memo.set(ms, e); return e;
}
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

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
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  const sessions = new Map();
  for (const b of all) { if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); }
  const days = [...sessions.keys()].sort();
  const s = { byT, sessions, days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => { const a = sessions.get(d); return a[a.length - 1].c; }) };
  book.set(sym, s); return s;
}
// the sessions of each window = the sessions of SPY in that window's own cache
function windowDays(win) {
  const f = path.join(CACHE_ROOT, 'oos_' + win, 'SPY.json');
  const set = new Set();
  for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) { const e = et(b.t); if (e.min >= 570 && e.min < 960) set.add(e.day); }
  return [...set].sort();
}
function byWindow(items, key = 'add') {
  let pos = 0, neg = 0; const per = [];
  for (const w of WINS) { const s = items.filter((r) => r.win === w).reduce((q, r) => q + r[key], 0); per.push(s); if (s > BAND) pos++; else if (s < -BAND) neg++; }
  return { pos, neg, per };
}

// ───────────────────────────── A: hold the bounce to the close ─────────────────────────────
const A = []; const skipA = { noBar: 0, flat: 0 };
for (const win of WINS) {
  const f = path.join(DIR, `${PREFIX}_${win}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const x = et(t.exit_ms);
    if (t.why !== 'sell' || x.min >= SALE_MIN) continue;      // the bounce exit, not the 15:50 rule and not a stop
    const s = load(t.sym);
    const entry = s.byT.has(t.entry_ms) ? s.byT.get(t.entry_ms).c : null;
    const sale = s.byT.has(t.exit_ms) ? s.byT.get(t.exit_ms).c : null;
    if (!(entry > 0) || !(sale > 0)) { skipA.noBar++; continue; }
    if (!(Math.abs(t.ret) > 1e-9)) { skipA.flat++; continue; }
    const rest = s.sessions.get(x.day).filter((b) => b.t > t.exit_ms && b.min <= SALE_MIN);
    const stop = entry * (1 - STOP_PCT);
    let plain = null, trail = null, peak = sale;
    for (const b of rest) {
      if (plain == null && b.l <= stop) plain = (b.h < stop ? b.c : stop);
      if (trail == null) { const fl = Math.max(stop, peak * (1 - TRAIL_PCT)); if (b.l <= fl) trail = (b.h < fl ? b.c : fl); else peak = Math.max(peak, b.c); }
    }
    const last = rest.length ? rest[rest.length - 1].c : sale;
    if (plain == null) plain = last; if (trail == null) trail = last;
    const value = (t.pnl / t.ret) * (sale / entry);
    A.push({ win, sym: t.sym, day: x.day, min: x.min, lev: LEV.has(t.sym), pnl: t.pnl, value, r: plain / sale - 1, add: value * (plain / sale - 1), rTrail: trail / sale - 1, addTrail: value * (trail / sale - 1), sameDay: et(t.entry_ms).day === x.day });
  }
}
console.log(`A. HOLD THE BOUNCE TO THE CLOSE: ${A.length} positions the bounce exit sold before 15:50 (their actual result ${usd(A.reduce((q, r) => q + r.pnl, 0))}), ${WINS.length} windows; skipped ${JSON.stringify(skipA)}`);
function rowA(name, set) {
  const w = byWindow(set), wt = byWindow(set, 'addTrail');
  const tot = set.reduce((q, r) => q + r.add, 0), totT = set.reduce((q, r) => q + r.addTrail, 0);
  console.log(`| ${name} | ${set.length} | ${usd(tot)} | ${pct(mean(set.map((r) => r.r)), 3)} | ${pct(set.length ? set.filter((r) => r.r > 0).length / set.length : null, 0)} | ${pct(set.length ? Math.min(...set.map((r) => r.r)) : null, 1)} | ${w.pos} | ${w.neg} | ${usd(totT)} | ${wt.pos} / ${wt.neg} |`);
  return { name, n: set.length, add: tot, pos: w.pos, neg: w.neg, per: w.per, addTrail: totT, posTrail: wt.pos, negTrail: wt.neg, mean: mean(set.map((r) => r.r)) };
}
console.log('| bucket | positions | dollars holding adds | per position | holds that add | worst hold | windows it adds | windows it costs | with the 1% floor | floor: adds / costs |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const resA = { all: rowA('every bounce exit', A), lev: rowA('3x and 2x names', A.filter((r) => r.lev)), one: rowA('1x names', A.filter((r) => !r.lev)), before12: rowA('sold before 12:00', A.filter((r) => r.min < 720)), after12: rowA('sold from 12:00', A.filter((r) => r.min >= 720)), soxl: rowA('SOXL alone', A.filter((r) => r.sym === 'SOXL')) };
console.log('by window, every bounce exit: ' + WINS.map((w, i) => `${label(w)} ${usd(resA.all.per[i])}`).join(' | '));
const needA = Math.ceil(WINS.length * 11 / 13);
console.log(`-> A ${resA.all.pos >= needA && resA.all.add > 0 ? 'CLEARS' : 'does not clear'} the bar (adds in ${resA.all.pos} of ${WINS.length}, needs ${needA})`);

// ───────────────────────────── B: buy the trend day ─────────────────────────────
const B = []; let sessionsSeen = 0;
for (const win of WINS) {
  const days = windowDays(win);
  for (const sym of LONGS) {
    const s = load(sym);
    for (const day of days) {
      const i = s.idx.get(day); if (i == null || i < 61) continue;
      const abs = []; let bad = false;
      for (let k = i - 60; k < i; k++) { const r1 = s.close[k] / s.close[k - 1] - 1; if (Math.abs(r1) > (LEV.has(sym) ? 0.6 : 0.3)) { bad = true; break; } abs.push(Math.abs(r1)); }
      if (bad) continue;
      const mad1 = median(abs); if (!(mad1 > 0)) continue;
      const bars = s.sessions.get(day); if (!bars || bars.length < 60) continue;   // a short session (half day, hole) is left out
      sessionsSeen++;
      let hi = -Infinity, lo = Infinity, trig = null;
      for (const b of bars) {
        hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
        if (!trig && CHECKS.includes(b.min) && hi > lo && (b.c - lo) / (hi - lo) >= TOP && (hi - lo) / lo >= RANGE_K * mad1) trig = { b, ibs: (b.c - lo) / (hi - lo), range: (hi - lo) / lo };
      }
      if (!trig) continue;
      const out = bars.find((b) => b.min === SALE_MIN) || bars[bars.length - 1];
      const after = bars.filter((b) => b.t > trig.b.t && b.t <= out.t);
      const worst = after.length ? Math.min(...after.map((b) => b.l)) / trig.b.c - 1 : 0;
      B.push({ win, sym, day, at: trig.b.min + 5, lev: LEV.has(sym), r: out.c / trig.b.c - 1, add: out.c / trig.b.c - 1, worst, rangeInMads: trig.range / mad1 });
    }
  }
}
console.log(`\nB. BUY THE TREND DAY: ${B.length} entries in ${sessionsSeen} name-sessions (${pct(B.length / sessionsSeen, 1)} of them), top ${100 * TOP}% of a range of at least ${RANGE_K} x the name's median daily move, at 10:30 / 11:30 / 13:00`);
function rowB(name, set) {
  let pos = 0, neg = 0; const per = [];
  for (const w of WINS) { const a = set.filter((r) => r.win === w); const m = mean(a.map((r) => r.r)); per.push({ n: a.length, m }); if (a.length >= 5) { if (m > 0.0002) pos++; else if (m < -0.0002) neg++; } }
  const m = mean(set.map((r) => r.r));
  console.log(`| ${name} | ${set.length} | ${pct(m, 3)} | ${pct(set.length ? set.filter((r) => r.r > 0).length / set.length : null, 0)} | ${pct(mean(set.filter((r) => r.r > 0).map((r) => r.r)), 2)} | ${pct(mean(set.filter((r) => r.r <= 0).map((r) => r.r)), 2)} | ${pct(mean(set.map((r) => r.worst)), 2)} | ${pos} | ${neg} |`);
  return { name, n: set.length, mean: m, wr: set.length ? set.filter((r) => r.r > 0).length / set.length : null, pos, neg, per };
}
console.log('| bucket | entries | mean to the close | entries that gain | mean gain | mean loss | mean worst point on the way | windows positive | windows negative |');
console.log('|---|---|---|---|---|---|---|---|---|');
const resB = { all: rowB('every trend-day entry', B), at1030: rowB('entered 10:30', B.filter((r) => r.at === 630)), at1130: rowB('entered 11:30', B.filter((r) => r.at === 690)), at1300: rowB('entered 13:00', B.filter((r) => r.at === 780)), lev: rowB('3x and 2x names', B.filter((r) => r.lev)), one: rowB('1x names', B.filter((r) => !r.lev)), wide: rowB('range of 2 x the median move or more', B.filter((r) => r.rangeInMads >= 2)), soxl: rowB('SOXL alone', B.filter((r) => r.sym === 'SOXL')) };
console.log('by window, every entry: ' + WINS.map((w, i) => `${label(w)} ${pct(resB.all.per[i].m, 2)} (${resB.all.per[i].n})`).join(' | '));
const needB = Math.ceil(WINS.length * 11 / 13);
console.log(`-> B ${resB.all.pos >= needB && resB.all.mean > 0 ? 'CLEARS' : 'does not clear'} the bar (positive in ${resB.all.pos} of ${WINS.length}, needs ${needB})`);
const out = flag('--json');
if (out) { fs.writeFileSync(out, JSON.stringify({ windows: WINS, A: resA, B: resB, sessionsSeen }, null, 1)); console.log('\nwrote', out); }
