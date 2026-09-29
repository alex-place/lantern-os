'use strict';
/**
 * stretch_anatomy.js — WHERE THE INCOME LIVES (ledger row stretch-bucket-13-windows, 2026-09-28).
 *
 * The 2026-09-17 separator study found one robust positive bucket on one window: stable entries
 * taken after a 5-session drop. This re-measures it on the armed stack's trades across the 13
 * scored windows. Nothing here replays anything: it joins the trade dumps of the two-sleeve
 * harness (REPLAY_DUMP) to daily closes built from the same 5m bar caches the harness read.
 *
 * NO LOOK-AHEAD: every feature of a trade is computed from sessions that were complete before
 * the entry session opened.
 *
 *   stretch5   the name's close-to-close return over the five completed sessions before the
 *              entry session
 *   mad5       the median of |5-session return| of that name over the 60 sessions before the
 *              entry session (its own scale: a 3x wrapper and a 1x fund are not judged alike)
 *   STRETCHED  stretch5 <= -K x mad5   (K = 1.0, fixed in the ledger row before the run)
 *   RAW        stretch5 <= -2.23%      (the 2026-09-17 definition)
 *
 * Usage: node experiments/stretch_anatomy.js <dumpDir> [prefix=pl_armed] [variant=P_armed] [--json out.json]
 *   caches are read from <os.tmpdir()>/oos_<window> (override the root with CACHE_ROOT)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUMP_DIR = process.argv[2];
const PREFIX = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'pl_armed';
const VAR = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 'P_armed';
const JSON_OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const OWNER = process.env.STRETCH_OWNER || '';            // '' = every sleeve, 'S' / 'R' = one
if (!DUMP_DIR) { console.error('usage: node stretch_anatomy.js <dumpDir> [prefix] [variant] [--json out.json]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const K = Number(process.env.STRETCH_K || 1.0);
const RAW = Number(process.env.STRETCH_RAW || -0.0223);

const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
// --wins a,b,c  = an explicit list; --wins map = every cached quarter that is NOT one of the 13 scored windows
const WINS_ARG = process.argv.includes('--wins') ? process.argv[process.argv.indexOf('--wins') + 1] : '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = new Proxy({ '22q2': 'Q2-22', '22q3': 'Q3-22', '23q1': 'Q1-23', '23q3': 'Q3-23', '24q3': 'Q3-24', '24q4': 'Q4-24', '25q1': 'Q1-25', '25q2': 'Q2-25', '25q3': 'Q3-25', q4: 'Q4-25', q1: 'Q1-26', aprjul: 'AprJul', julsep: 'JulSep' },
  { get: (o, k) => o[k] || (/^\d\dq\d$/.test(String(k)) ? `Q${String(k)[3]}-${String(k).slice(0, 2)}` : String(k)) });
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);

// ── daily closes from every cache directory (a session in two caches is the same session) ──
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const et = (ms) => { const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value; return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) }; };
const dirs = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_/.test(d));
const daily = new Map();                                   // SYM -> Map(day -> { close, first })
const dayOf = new Map();                                   // memo: utc-day bucket is not enough, ET day per bar start
function load(sym) {
  if (daily.has(sym)) return daily.get(sym);
  const m = new Map();
  for (const d of dirs) {
    const f = path.join(CACHE_ROOT, d, sym + '.json');
    if (!fs.existsSync(f)) continue;
    let bars; try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { continue; }
    for (const b of bars) {
      let e = dayOf.get(b.t); if (!e) { e = et(b.t); dayOf.set(b.t, e); }
      if (e.min < 570 || e.min >= 960) continue;           // the regular session only
      const cur = m.get(e.day);
      if (!cur) m.set(e.day, { close: Number(b.c), lastMin: e.min, first: Number(b.c), firstMin: e.min });
      else { if (e.min >= cur.lastMin) { cur.close = Number(b.c); cur.lastMin = e.min; } if (e.min < cur.firstMin) { cur.first = Number(b.c); cur.firstMin = e.min; } }
    }
  }
  const days = [...m.keys()].sort();
  const series = { days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => m.get(d).close), first: days.map((d) => m.get(d).first) };
  daily.set(sym, series);
  return series;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
function features(sym, day) {
  const s = load(sym); const i = s.idx.get(day);
  if (i == null || i < 66) return null;                    // needs 60 sessions of 5-session returns before the entry session
  const r5 = (j) => s.close[j] / s.close[j - 5] - 1;       // the five sessions ending at j
  // a split the cache did not adjust shows as an impossible one-session move: the feature is dropped, not guessed
  for (let j = i - 65; j < i; j++) { const r1 = s.close[j] / s.close[j - 1] - 1; if (Math.abs(r1) > (LEV.has(sym) ? 0.6 : 0.3)) return null; }
  const abs = []; for (let j = i - 60; j < i; j++) abs.push(Math.abs(r5(j)));
  const mad5 = median(abs);
  return { stretch5: r5(i - 1), mad5, z: mad5 > 0 ? r5(i - 1) / mad5 : NaN, gap: s.first[i] / s.close[i - 1] - 1 };
}
// the tape, as it stood at the last completed close before the entry session (SPY unless told otherwise)
function tape(day, sym = 'SPY') {
  const s = load(sym); const i = s.idx.get(day);
  if (i == null || i < 201) return null;
  const sma = (n) => { let a = 0; for (let j = i - n; j < i; j++) a += s.close[j]; return a / n; };
  const c = s.close[i - 1];
  return { below50: c < sma(50), below200: c < sma(200), r20neg: c / s.close[i - 21] - 1 < 0, r60neg: c / s.close[i - 61] - 1 < 0 };
}

// ── trades ──
const trades = [];
let noFeature = 0;
for (const w of WINS) {
  const f = path.join(DUMP_DIR, `${PREFIX}_${w}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (OWNER && t.owner !== OWNER) continue;
    const day = et(t.entry_ms).day;
    const ft = features(t.sym, day); const spy = features('SPY', day);
    if (!ft || !Number.isFinite(ft.z)) { noFeature++; continue; }
    trades.push({ win: w, sym: t.sym, day, ret: Number(t.ret), pnl: Number(t.pnl), why: t.why, entry_ms: t.entry_ms, exit_ms: t.exit_ms, ...ft, spyZ: spy && Number.isFinite(spy.z) ? spy.z : null, tape: tape(day), own: tape(day, t.sym) });
  }
}

const stat = (a) => { const n = a.length; if (!n) return { n: 0, wr: null, mean: null, pnl: 0, pf: null }; let w = 0, gp = 0, gl = 0, s = 0; for (const t of a) { s += t.ret; if (t.pnl > 0) { w++; gp += t.pnl; } else gl -= t.pnl; } return { n, wr: w / n, mean: s / n, pnl: gp - gl, pf: gl ? gp / gl : null }; };
const pct = (x, d = 2) => (x == null ? '-' : (100 * x).toFixed(d) + '%');
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');

function split(name, isIn) {
  const A = trades.filter(isIn), B = trades.filter((t) => !isIn(t));
  const a = stat(A), b = stat(B), all = stat(trades);
  const rowsW = []; let better = 0, decided = 0, inNeg = 0;
  for (const w of WINS) {
    const x = stat(A.filter((t) => t.win === w)), y = stat(B.filter((t) => t.win === w));
    if (x.n >= 5 && y.n >= 5) { decided++; if (x.mean > y.mean) better++; }
    if (x.n && x.pnl < 0) inNeg++;
    rowsW.push({ win: w, in: x, out: y });
  }
  return { name, in: a, out: b, share_trades: a.n / all.n, share_pnl: all.pnl ? a.pnl / all.pnl : null, ratio: b.mean ? a.mean / b.mean : null, better, decided, windows_in_bucket_negative: inNeg, byWin: rowsW };
}
function show(r) {
  console.log(`\n### ${r.name}`);
  console.log(`in the bucket: ${r.in.n} trades (${pct(r.share_trades, 0)} of the trades, ${pct(r.share_pnl, 0)} of the profit), WR ${pct(r.in.wr, 0)}, mean ${pct(r.in.mean, 3)} per trade, PF ${r.in.pf == null ? '-' : r.in.pf.toFixed(2)}, ${usd(r.in.pnl)}`);
  console.log(`the rest:      ${r.out.n} trades, WR ${pct(r.out.wr, 0)}, mean ${pct(r.out.mean, 3)} per trade, PF ${r.out.pf == null ? '-' : r.out.pf.toFixed(2)}, ${usd(r.out.pnl)}`);
  console.log(`per-trade ratio ${r.ratio == null ? '-' : r.ratio.toFixed(2)}x | bucket better in ${r.better} of ${r.decided} windows | bucket itself negative in ${r.windows_in_bucket_negative} of ${WINS.length}`);
  console.log('| window | bucket n | bucket WR | bucket mean | bucket $ | rest n | rest WR | rest mean | rest $ | better |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.byWin) console.log(`| ${LABEL[x.win]} | ${x.in.n} | ${pct(x.in.wr, 0)} | ${pct(x.in.mean, 3)} | ${usd(x.in.pnl)} | ${x.out.n} | ${pct(x.out.wr, 0)} | ${pct(x.out.mean, 3)} | ${usd(x.out.pnl)} | ${x.in.n >= 5 && x.out.n >= 5 ? (x.in.mean > x.out.mean ? 'yes' : 'NO') : 'n<5'} |`);
}

console.log(`${trades.length} trades with features (${noFeature} without: no 66-session history or an unadjusted split), ${WINS.length} windows, total ${usd(trades.reduce((a, t) => a + t.pnl, 0))}${OWNER ? ', sleeve ' + OWNER : ''}`);
const results = {};
results.primary = split(`PRIMARY (scored): stretch5 <= -${K} x the name's own median 5-session move`, (t) => t.z <= -K);
results.raw = split(`SECONDARY: raw stretch5 <= ${(100 * RAW).toFixed(2)}% (the 2026-09-17 definition)`, (t) => t.stretch5 <= RAW);
results.context = split(`STRETCHED CONTEXT: the name OR SPY fell by more than ${K} x its own median 5-session move`, (t) => t.z <= -K || (t.spyZ != null && t.spyZ <= -K));
show(results.primary); show(results.raw); show(results.context);

console.log('\n## EXPLORATORY (not scored; read as hypotheses only)');
results.deep = split('deeper: z <= -2', (t) => t.z <= -2); show(results.deep);
results.up = split('the opposite tail: z >= +1 (the name ROSE by more than its usual 5-session move)', (t) => t.z >= 1); show(results.up);
results.spy = split('the market is stretched: SPY z <= -1', (t) => t.spyZ != null && t.spyZ <= -1); show(results.spy);
results.lev = split('stretched AND a leveraged wrapper', (t) => t.z <= -K && LEV.has(t.sym)); show(results.lev);
results.one = split('stretched AND a 1x fund', (t) => t.z <= -K && !LEV.has(t.sym)); show(results.one);
results.gapdn = split('the entry session opened below the prior close by more than 0.5 x mad5 / sqrt(5)', (t) => t.gap <= -0.5 * t.mad5 / Math.sqrt(5)); show(results.gapdn);

// ── the tape x the stretch: which entries earn in which tape? ──
// WEAK is read at the last completed close. STRETCHED here = the name OR the market fell by more than its own
// usual 5-session move. The cell that matters is WEAK and NOT stretched: the shallow dip in a falling tape.
function grid(title, isWeak, isStretched) {
  const cells = { 'weak, stretched': [], 'weak, NOT stretched': [], 'strong, stretched': [], 'strong, NOT stretched': [] };
  let skipped = 0;
  for (const t of trades) { const w = isWeak(t); if (w == null) { skipped++; continue; } cells[`${w ? 'weak' : 'strong'}, ${isStretched(t) ? 'stretched' : 'NOT stretched'}`].push(t); }
  console.log(`\n### ${title}${skipped ? ` (${skipped} trades without a 200-session tape)` : ''}`);
  console.log('| cell | n | WR | mean per trade | PF | $ | windows negative | windows positive |'); console.log('|---|---|---|---|---|---|---|---|');
  const out = {};
  for (const [k, a] of Object.entries(cells)) {
    const s = stat(a); let neg = 0, pos = 0;
    for (const w of WINS) { const x = a.filter((t) => t.win === w); if (x.length < 5) continue; const p = x.reduce((q, t) => q + t.pnl, 0); if (p < 0) neg++; else pos++; }
    out[k] = { ...s, neg, pos };
    console.log(`| ${k} | ${s.n} | ${pct(s.wr, 0)} | ${pct(s.mean, 3)} | ${s.pf == null ? '-' : s.pf.toFixed(2)} | ${usd(s.pnl)} | ${neg} | ${pos} |`);
  }
  return out;
}
const either = (t) => t.z <= -K || (t.spyZ != null && t.spyZ <= -K);
results.grid = {
  below50_either: grid('SPY below its 50-session average x (name or market stretched)', (t) => (t.tape ? t.tape.below50 : null), either),
  below200_either: grid('SPY below its 200-session average x (name or market stretched)', (t) => (t.tape ? t.tape.below200 : null), either),
  r20neg_either: grid('SPY 20-session return negative x (name or market stretched)', (t) => (t.tape ? t.tape.r20neg : null), either),
  r60neg_either: grid('SPY 60-session return negative x (name or market stretched)', (t) => (t.tape ? t.tape.r60neg : null), either),
  below50_name: grid('SPY below its 50-session average x the NAME stretched', (t) => (t.tape ? t.tape.below50 : null), (t) => t.z <= -K),
  below50_market: grid('SPY below its 50-session average x the MARKET stretched', (t) => (t.tape ? t.tape.below50 : null), (t) => t.spyZ != null && t.spyZ <= -K),
  own50_name: grid('the NAME below its own 50-session average x the name stretched', (t) => (t.own ? t.own.below50 : null), (t) => t.z <= -K),
};

// z quintiles, pooled: is the effect monotone?
const sorted = [...trades].sort((a, b) => a.z - b.z); const q = Math.ceil(sorted.length / 5);
console.log('\n### z quintiles (pooled; 1 = the most stretched down)');
console.log('| quintile | z range | n | WR | mean per trade | PF | $ |'); console.log('|---|---|---|---|---|---|---|');
results.quintiles = [];
for (let i = 0; i < 5; i++) { const a = sorted.slice(i * q, (i + 1) * q); const s = stat(a); results.quintiles.push({ q: i + 1, lo: a[0].z, hi: a[a.length - 1].z, ...s }); console.log(`| ${i + 1} | ${a[0].z.toFixed(2)} .. ${a[a.length - 1].z.toFixed(2)} | ${s.n} | ${pct(s.wr, 0)} | ${pct(s.mean, 3)} | ${s.pf.toFixed(2)} | ${usd(s.pnl)} |`); }

// slots: are the best days the days the slot ceiling binds?
const byDay = new Map();
for (const w of WINS) {
  const T = trades.filter((t) => t.win === w);
  const days = [...new Set(T.map((t) => et(t.exit_ms).day))];
  for (const d of days) {
    const pnl = T.filter((t) => et(t.exit_ms).day === d).reduce((a, t) => a + t.pnl, 0);
    const open = T.filter((t) => et(t.entry_ms).day <= d && et(t.exit_ms).day >= d);
    const ev = []; for (const t of open) { ev.push([t.entry_ms, 1]); ev.push([t.exit_ms, -1]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let c = 0, mx = 0; for (const [ms, k] of ev) { c += k; if (et(ms).day === d && c > mx) mx = c; }
    byDay.set(w + ':' + d, { pnl, max: mx, entries: T.filter((t) => et(t.entry_ms).day === d).length });
  }
}
const D = [...byDay.values()].sort((a, b) => b.pnl - a.pnl); const top = D.slice(0, Math.ceil(D.length / 10));
const hist = (a) => { const h = {}; for (const x of a) h[x.max] = (h[x.max] || 0) + 1; return Object.keys(h).sort((x, y) => x - y).map((k) => `${k}: ${h[k]}`).join(', '); };
const totalPnl = D.reduce((a, x) => a + x.pnl, 0);
console.log(`\n### slots on the best days (days with at least one exit: ${D.length})`);
console.log(`top decile of days: ${top.length} days, ${usd(top.reduce((a, x) => a + x.pnl, 0))} of ${usd(totalPnl)}; peak slots in use that day -> ${hist(top)}`);
console.log(`every day: peak slots in use -> ${hist(D)}`);
results.slots = { days: D.length, top_days: top.length, top_pnl: top.reduce((a, x) => a + x.pnl, 0), total_pnl: totalPnl, top_at_6: top.filter((x) => x.max >= 6).length, all_at_6: D.filter((x) => x.max >= 6).length, top_mean_peak: top.reduce((a, x) => a + x.max, 0) / top.length, all_mean_peak: D.reduce((a, x) => a + x.max, 0) / D.length };

if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify({ made: new Date().toISOString(), trades: trades.length, no_feature: noFeature, K, RAW, results }, null, 1)); console.log('\nwrote', JSON_OUT); }
