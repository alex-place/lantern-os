'use strict';
/**
 * prior_close_anatomy.js — IS A WASHOUT BOUGHT ABOVE YESTERDAY'S CLOSE A WORSE ENTRY?
 * (ledger row washout-above-prior-close-13-windows, 2026-09-29).
 *
 * The washout is measured inside today's range, so a name that gapped up and faded reads as
 * washed out while it is still up on the day. Live 2026-09-29: SOXL, bought at session IBS 0.29
 * while 3.7% above the prior close, was the largest loss on both boxes.
 *
 * Nothing here replays anything: it joins the trade dumps of the two-sleeve harness (REPLAY_DUMP)
 * to the same 5m bar caches the harness read.
 *
 * NO LOOK-AHEAD: x uses the bar the harness filled on and the prior session's close; the scale
 * (mad1) uses only sessions that were complete before the entry session opened.
 *
 *   x       entry price / prior session close - 1   (entry price = close of the 5m bar filled on)
 *   mad1    the median |close-to-close move| of that name over the 60 sessions before the entry
 *           session (its own scale: a 3x wrapper and a 1x fund are not judged alike)
 *   ABOVE   x >= +K x mad1      BELOW   x <= -K x mad1      FLAT   between    (K = 0.5, fixed in
 *           the ledger row before the run)
 *
 * Usage: node experiments/prior_close_anatomy.js <dumpDir> [prefix=floor] [variant=F_armed] [--json out.json] [--wins a,b|map]
 *   caches are read from <os.tmpdir()>/oos_<window> (override the root with CACHE_ROOT)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const DUMP_DIR = positional[0];
const PREFIX = positional[1] || 'floor';
const VAR = positional[2] || 'F_armed';
const JSON_OUT = flag('--json');
const OWNER = process.env.ANATOMY_OWNER || '';            // '' = every sleeve, 'S' / 'R' = one
if (!DUMP_DIR) { console.error('usage: node prior_close_anatomy.js <dumpDir> [prefix] [variant] [--json out.json] [--wins a,b|map]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const K = Number(process.env.PRIOR_CLOSE_K || 0.5);
const MIN_N = 5;                                           // a window decides only when both buckets hold this many

const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const WINS_ARG = flag('--wins') || '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = { q4: 'Q4-25', q1: 'Q1-26', aprjul: 'AprJul-26', julsep: 'JulSep-26' };
const label = (w) => NAMES[w] || (/^\d\dq\d$/.test(w) ? `Q${w[3]}-${w.slice(0, 2)}` : w);
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const etMemo = new Map();
function et(ms) {
  let e = etMemo.get(ms);
  if (!e) {
    const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
    e = { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
    etMemo.set(ms, e);
  }
  return e;
}

// ── per name: daily closes of the regular session, and every regular-session 5m bar by start time ──
const dirs = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_/.test(d));
const book = new Map();                                    // SYM -> { days, idx, close, bar: Map(t -> close), open: Map(day -> first bar close) }
function load(sym) {
  if (book.has(sym)) return book.get(sym);
  const m = new Map(); const bar = new Map();
  for (const d of dirs) {
    const f = path.join(CACHE_ROOT, d, sym + '.json');
    if (!fs.existsSync(f)) continue;
    let bars; try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { continue; }
    for (const b of bars) {
      const e = et(b.t);
      if (e.min < 570 || e.min >= 960) continue;           // the regular session only
      bar.set(b.t, Number(b.c));
      const cur = m.get(e.day);
      if (!cur) m.set(e.day, { close: Number(b.c), lastMin: e.min });
      else if (e.min >= cur.lastMin) { cur.close = Number(b.c); cur.lastMin = e.min; }
    }
  }
  const days = [...m.keys()].sort();
  const s = { days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => m.get(d).close), bar };
  book.set(sym, s);
  return s;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

const why = { no_history: 0, split: 0, no_bar: 0 };
function features(sym, entryMs) {
  const s = load(sym); const day = et(entryMs).day; const i = s.idx.get(day);
  if (i == null || i < 61) { why.no_history++; return null; }
  const abs = [];
  for (let j = i - 60; j < i; j++) {
    const r1 = s.close[j] / s.close[j - 1] - 1;
    // a split the cache did not adjust shows as an impossible one-session move: the feature is dropped, not guessed
    if (Math.abs(r1) > (LEV.has(sym) ? 0.6 : 0.3)) { why.split++; return null; }
    abs.push(Math.abs(r1));
  }
  const mad1 = median(abs);
  // the harness fills at the close of the bar it decided on; a dump that names the bar start or the bar end both land here
  let px = s.bar.get(entryMs);
  if (px == null) px = s.bar.get(entryMs - 300000);
  if (px == null) { why.no_bar++; return null; }
  const prior = s.close[i - 1];
  const x = px / prior - 1;
  return { day, x, mad1, u: mad1 > 0 ? x / mad1 : NaN, px, prior };
}

// ── trades ──
const trades = [];
for (const w of WINS) {
  const f = path.join(DUMP_DIR, `${PREFIX}_${w}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (OWNER && t.owner !== OWNER) continue;
    const ft = features(t.sym, t.entry_ms);
    if (!ft || !Number.isFinite(ft.u)) continue;
    trades.push({ win: w, sym: t.sym, ret: Number(t.ret), pnl: Number(t.pnl), why: t.why, lev: LEV.has(t.sym), ...ft });
  }
}

function stat(a) {
  const n = a.length; if (!n) return { n: 0, wr: null, mean: null, pnl: 0, pf: null };
  let w = 0, gp = 0, gl = 0, s = 0;
  for (const t of a) { s += t.ret; if (t.pnl > 0) { w++; gp += t.pnl; } else gl -= t.pnl; }
  return { n, wr: w / n, mean: s / n, pnl: gp - gl, pf: gl > 0 ? gp / gl : null };
}
const pct = (x, d = 2) => (x == null ? '-' : (100 * x).toFixed(d) + '%');
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const line = (name, s, all) => `${name.padEnd(8)} ${String(s.n).padStart(5)} trades (${pct(s.n / all.n, 0)}), WR ${pct(s.wr, 0)}, mean ${pct(s.mean, 3)} per trade, PF ${s.pf == null ? '-' : s.pf.toFixed(2)}, ${usd(s.pnl)} (${pct(all.pnl ? s.pnl / all.pnl : null, 0)} of the profit)`;

function versus(title, isA, isB, nameA, nameB, set = trades) {
  const A = set.filter(isA), B = set.filter(isB), all = stat(set);
  const a = stat(A), b = stat(B);
  let lower = 0, decided = 0, aNeg = 0, aWin = 0;
  const byWin = [];
  for (const w of WINS) {
    const x = stat(A.filter((t) => t.win === w)), y = stat(B.filter((t) => t.win === w));
    const dec = x.n >= MIN_N && y.n >= MIN_N;
    if (dec) { decided++; if (x.mean < y.mean) lower++; }
    if (x.n) { aWin++; if (x.pnl < 0) aNeg++; }
    byWin.push({ win: w, a: x, b: y, decided: dec, a_lower: dec ? x.mean < y.mean : null });
  }
  console.log(`\n### ${title}`);
  console.log(line(nameA, a, all));
  console.log(line(nameB, b, all));
  console.log(`${nameA} lower than ${nameB} in ${lower} of ${decided} decided windows | ${nameA} itself net negative in ${aNeg} of ${aWin} windows`);
  console.log(`| window | ${nameA} n | WR | mean | $ | ${nameB} n | WR | mean | $ | ${nameA} lower |`);
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of byWin) console.log(`| ${label(r.win)} | ${r.a.n} | ${pct(r.a.wr, 0)} | ${pct(r.a.mean, 3)} | ${usd(r.a.pnl)} | ${r.b.n} | ${pct(r.b.wr, 0)} | ${pct(r.b.mean, 3)} | ${usd(r.b.pnl)} | ${r.a_lower == null ? 'n/a' : r.a_lower ? 'yes' : 'no'} |`);
  return { title, a, b, lower, decided, a_negative_windows: aNeg, a_windows: aWin, byWin };
}

const all = stat(trades);
console.log(`${trades.length} trades with features, ${WINS.length} windows, total ${usd(all.pnl)}, mean ${pct(all.mean, 3)} per trade${OWNER ? ', sleeve ' + OWNER : ''}`);
console.log(`dropped: ${why.no_history} without 61 sessions of history, ${why.split} with an unadjusted split in the scale window, ${why.no_bar} without the fill bar in the cache`);
const above = (t) => t.u >= K, below = (t) => t.u <= -K, flat = (t) => t.u > -K && t.u < K;
console.log('\n## the three buckets, all windows together');
console.log(line('ABOVE', stat(trades.filter(above)), all));
console.log(line('FLAT', stat(trades.filter(flat)), all));
console.log(line('BELOW', stat(trades.filter(below)), all));

const results = { k: K, windows: WINS, trades: trades.length, dropped: why, total: all };
results.primary = versus(`PRIMARY (scored): ABOVE (x >= +${K} x mad1) against BELOW (x <= -${K} x mad1)`, above, below, 'ABOVE', 'BELOW');
results.sign = versus('SECONDARY (not scored): up on the day against down on the day at the entry', (t) => t.x > 0, (t) => t.x <= 0, 'UP', 'DOWN');
results.far = versus('SECONDARY (not scored): far above (x >= +1.5 x mad1) against everything else', (t) => t.u >= 1.5, (t) => t.u < 1.5, 'FAR', 'REST');
results.lev = versus('SECONDARY (not scored): leveraged names only, ABOVE against BELOW', above, below, 'ABOVE', 'BELOW', trades.filter((t) => t.lev));

// how the ABOVE bucket ends: the live loss was a forced close
console.log('\n## how each bucket ends');
for (const [name, fn] of [['ABOVE', above], ['FLAT', flat], ['BELOW', below]]) {
  const set = trades.filter(fn); const by = {};
  for (const t of set) { const k = String(t.why); (by[k] = by[k] || []).push(t); }
  console.log(`${name}: ` + Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => { const s = stat(v); return `${k} ${s.n} (WR ${pct(s.wr, 0)}, mean ${pct(s.mean, 3)}, ${usd(s.pnl)})`; }).join(' | '));
}
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1)); console.log('\nwrote', JSON_OUT); }
