'use strict';
/**
 * carry_anatomy.js — WHEN DOES HOLDING PAY? (ledger row conditional-carry-anatomy-13-windows, 2026-09-29).
 *
 * The armed stack sells its 3x equity names at 15:50 ET every day (decarry) and everything at 15:50 on
 * Fridays (weekend flat). Those sales are the one bucket that loses in every window. Carrying them
 * without condition is measured (decarry off, weekend hold): a regime trade-off, not an edge. This asks
 * whether a condition KNOWN AT 15:50 separates the nights on which the carry pays.
 *
 * Nothing is replayed: the positions come from the harness dumps (REPLAY_DUMP), the prices from the
 * same 5m bar caches the harness read. Each position the rule sold is carried ONE more session:
 *
 *   stop     3% under the entry, checked on every 5m bar of the next session; a bar wholly under the
 *            stop fills at its close (the pessimistic convention of REPLAY_GAP_FILL=close)
 *   bounce   the first 5m close at session IBS >= 0.6 once the session is 30 minutes old
 *   clock    else the close of the 15:50 bar of that next session
 *
 * This is a PROXY of the brain (no step floor, no break-even ratchet, no slot effects). Its sum without
 * condition is printed beside the replay's own numbers so the reader can judge how far off it is.
 *
 * NO LOOK-AHEAD: every condition uses the 15:50 bar of the sale and sessions completed before it.
 *
 * Usage: node experiments/carry_anatomy.js <dumpDir> [prefix=floor] [variant=F_armed] [--wins a,b|map] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const DIR = positional[0], PREFIX = positional[1] || 'floor', VAR = positional[2] || 'F_armed';
if (!DIR) { console.error('usage: node carry_anatomy.js <dumpDir> [prefix] [variant] [--wins a,b|map] [--json out.json]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const WINS_ARG = flag('--wins') || '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = { q4: 'Q4-25', q1: 'Q1-26', aprjul: 'AprJul-26', julsep: 'JulSep-26' };
const label = (w) => NAMES[w] || (/^\d\dq\d$/.test(w) ? `Q${w[3]}-${w.slice(0, 2)}` : w);
const DECARRY = new Set(String(process.env.CLOSE_DECARRY || 'TQQQ,SQQQ,SOXL,SOXS,SPXL,SPXS,TNA,TZA,UPRO').split(','));
const INVERSE = new Set(['SQQQ', 'SOXS', 'SPXS', 'TZA', 'SDS', 'SH', 'PSQ', 'ERY', 'FAZ', 'DUST', 'JDST', 'SCO']);
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);
const STOP_PCT = Number(process.env.CARRY_STOP_PCT || 3) / 100;
const IBS_EXIT = Number(process.env.CARRY_IBS_EXIT || 0.6);
const AGE_MIN = Number(process.env.CARRY_AGE_MIN || 30);
const SALE_MIN = 950;                                       // 15:50 ET
const BAND = 50;                                            // a window decides beyond +/- this many dollars

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

// ── one timeline per name, merged from every cache directory (a bar in two caches is the same bar) ──
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
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); }

/** One more session under the rule-like exit. Returns { r, how } with r measured from the 15:50 sale price. */
function carryOne(sym, saleDay, salePx, entryPx) {
  const s = load(sym); const i = s.idx.get(saleDay);
  if (i == null || i + 1 >= s.days.length) return null;
  const next = s.sessions.get(s.days[i + 1]);
  // a gap of more than 6 calendar days between the sessions is a hole in the cache, not a weekend
  if ((next[0].t - s.sessions.get(saleDay)[0].t) / 86400000 > 6) return null;
  const stop = entryPx * (1 - STOP_PCT);
  let hi = -Infinity, lo = Infinity;
  const first = next[0];
  const out = { gap: first.c / salePx - 1, nextDay: s.days[i + 1] };
  for (const b of next) {
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    if (b.l <= stop) { const px = b.h < stop ? b.c : stop; return { ...out, r: px / salePx - 1, how: 'stop', min: b.min }; }
    if (b.min - 570 + 5 >= AGE_MIN && hi > lo && (b.c - lo) / (hi - lo) >= IBS_EXIT) return { ...out, r: b.c / salePx - 1, how: 'bounce', min: b.min };
    if (b.min >= SALE_MIN) return { ...out, r: b.c / salePx - 1, how: 'clock', min: b.min };
  }
  const last = next[next.length - 1];
  return { ...out, r: last.c / salePx - 1, how: 'clock', min: last.min };
}

/** Conditions at the 15:50 sale, from completed sessions only. */
function context(sym, saleDay, salePx) {
  const s = load(sym); const i = s.idx.get(saleDay);
  const spy = load('SPY'); const j = spy.idx.get(saleDay);
  if (i == null || j == null || i < 21 || j < 201) return null;
  for (let k = i - 20; k < i; k++) { const r1 = s.close[k] / s.close[k - 1] - 1; if (Math.abs(r1) > (LEV.has(sym) ? 0.6 : 0.3)) return null; }   // an unadjusted split: dropped, not guessed
  const spyNow = (spy.sessions.get(saleDay).find((b) => b.min === SALE_MIN) || spy.sessions.get(saleDay).slice(-1)[0]).c;
  const sma = (ser, at, n) => mean(ser.close.slice(at - n, at));
  const inv = INVERSE.has(sym);
  const rets = []; for (let k = j - 20; k < j; k++) rets.push(spy.close[k] / spy.close[k - 1] - 1);
  const above200 = spyNow > sma(spy, j, 200), above50 = spyNow > sma(spy, j, 50);
  return {
    regime200: inv ? !above200 : above200,
    regime50: inv ? !above50 : above50,
    nameUp20: salePx > sma(s, i, 20),
    calm: sd(rets) * Math.sqrt(252) < 0.16,
    dayUp: salePx > s.close[i - 1],
    spyDayUp: spyNow > spy.close[j - 1],
  };
}

// ── the positions the rule sold ──
const rows = []; const skipped = { noBar: 0, flat: 0, noNext: 0, noContext: 0 };
for (const win of WINS) {
  const f = path.join(DIR, `${PREFIX}_${win}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const x = et(t.exit_ms);
    const ruled = DECARRY.has(t.sym) || x.wd === 'Fri';
    if (!ruled || x.min !== SALE_MIN || t.why === 'stop') continue;
    const s = load(t.sym);
    const entry = s.byT.has(t.entry_ms) ? s.byT.get(t.entry_ms).c : null;
    const sale = s.byT.has(t.exit_ms) ? s.byT.get(t.exit_ms).c : null;
    if (!(entry > 0) || !(sale > 0)) { skipped.noBar++; continue; }
    if (!(Math.abs(t.ret) > 1e-9)) { skipped.flat++; continue; }
    const c = carryOne(t.sym, x.day, sale, entry);
    if (!c) { skipped.noNext++; continue; }
    const ctx = context(t.sym, x.day, sale);
    if (!ctx) { skipped.noContext++; continue; }
    const value = (t.pnl / t.ret) * (sale / entry);           // what the position was worth at the sale
    rows.push({ win, sym: t.sym, day: x.day, fri: x.wd === 'Fri', dec: DECARRY.has(t.sym), pnl: t.pnl, ret: t.ret, value, add: value * c.r, gapAdd: value * c.gap, r: c.r, how: c.how, inProfit: t.ret > 0, ...ctx });
  }
}
const total = (a, k = 'add') => a.reduce((q, r) => q + r[k], 0);
console.log(`${rows.length} positions sold by the 15:50 rule and carried one more session on paper, ${WINS.length} windows; the rule's own result on them ${usd(total(rows, 'pnl'))}; skipped ${JSON.stringify(skipped)}`);
console.log(`exit model: stop ${100 * STOP_PCT}% under the entry, bounce at session IBS >= ${IBS_EXIT} after ${AGE_MIN} min, else 15:50 of the next session`);

function bucket(name, pick, set = rows) {
  const A = set.filter(pick);
  let pos = 0, neg = 0; const per = [];
  for (const w of WINS) { const s = total(A.filter((r) => r.win === w)); per.push(s); if (s > BAND) pos++; else if (s < -BAND) neg++; }
  const wins = A.filter((r) => r.add > 0).length;
  const worst = A.length ? Math.min(...A.map((r) => r.r)) : null;
  return { name, n: A.length, add: total(A), gapAdd: total(A, 'gapAdd'), pos, neg, per, wr: A.length ? wins / A.length : null, mean: A.length ? mean(A.map((r) => r.r)) : null, worst, how: A.reduce((o, r) => { o[r.how] = (o[r.how] || 0) + 1; return o; }, {}) };
}
function line(b) {
  return `| ${b.name} | ${b.n} | ${usd(b.add)} | ${pct(b.mean, 3)} | ${pct(b.wr, 0)} | ${pct(b.worst, 1)} | ${b.pos} | ${b.neg} | ${usd(b.gapAdd)} |`;
}
const HEAD = '| bucket | positions | dollars the carry adds | per position | carries that add | worst carry | windows it adds | windows it costs | the overnight gap alone |\n|---|---|---|---|---|---|---|---|---|';

console.log('\n## without condition');
console.log(HEAD);
const all = bucket('every position the rule sold', () => true);
console.log(line(all));
console.log(line(bucket('3x equity names, Monday to Thursday', (r) => r.dec && !r.fri)));
console.log(line(bucket('3x equity names, Fridays', (r) => r.dec && r.fri)));
console.log(line(bucket('every other name, Fridays', (r) => !r.dec && r.fri)));
console.log(`how the carries end: ${JSON.stringify(all.how)}`);
console.log('\nby window, without condition: ' + WINS.map((w, i) => `${label(w)} ${usd(all.per[i])}`).join(' | '));

const CONDS = [
  ['regime200', 'WITH THE REGIME 200'], ['regime50', 'WITH THE REGIME 50'], ['nameUp20', 'NAME UP 20'], ['calm', 'CALM'],
  ['dayUp', 'UP ON THE DAY'], ['inProfit', 'IN PROFIT'], ['spyDayUp', 'SPY UP ON THE DAY'],
];
const results = { windows: WINS, positions: rows.length, skipped, all, conds: {} };
console.log('\n## the conditions (scored): the bucket that would be carried, and its complement');
console.log(HEAD);
for (const [k, name] of CONDS) {
  const yes = bucket(name, (r) => r[k] === true), no = bucket('   not ' + name.toLowerCase(), (r) => r[k] === false);
  const need = Math.ceil(WINS.length * 11 / 13);
  const clears = yes.pos >= need && yes.add > 0 && !(no.pos > WINS.length / 2);
  results.conds[k] = { yes, no, clears };
  console.log(line(yes)); console.log(line(no));
  console.log(`| -> ${name}: ${clears ? 'CLEARS the bar' : 'does not clear the bar'} (needs ${need} of ${WINS.length} windows, a positive total, and a complement that does not add in a majority) | | | | | | | | |`);
}
console.log('\n## by window, the two regime conditions (dollars the carry adds)');
console.log('| window | every position | with the regime 200 | against it | with the regime 50 | against it |\n|---|---|---|---|---|---|');
WINS.forEach((w, i) => console.log(`| ${label(w)} | ${usd(all.per[i])} | ${usd(results.conds.regime200.yes.per[i])} | ${usd(results.conds.regime200.no.per[i])} | ${usd(results.conds.regime50.yes.per[i])} | ${usd(results.conds.regime50.no.per[i])} |`));

// by kind, inside the best-looking condition: is the separation the same for the daily decarry and for the weekend?
console.log('\n## the regime 200 condition by kind');
console.log(HEAD);
for (const [nm, pk] of [['3x Mon-Thu, with the regime', (r) => r.dec && !r.fri && r.regime200], ['3x Mon-Thu, against it', (r) => r.dec && !r.fri && !r.regime200], ['Fridays, with the regime', (r) => r.fri && r.regime200], ['Fridays, against it', (r) => r.fri && !r.regime200]]) console.log(line(bucket(nm, pk)));

// by name: where the carry lives (reported, not scored: 20-odd names over 13 windows invites a fit)
console.log('\n## by name, without condition (reported, not scored)');
console.log('| name | positions | dollars the carry adds | per position | carries that add | windows it adds | windows it costs |\n|---|---|---|---|---|---|---|');
const syms = [...new Set(rows.map((r) => r.sym))].map((s) => bucket(s, (r) => r.sym === s)).sort((a, b) => b.add - a.add);
for (const b of syms) console.log(`| ${b.name} | ${b.n} | ${usd(b.add)} | ${pct(b.mean, 3)} | ${pct(b.wr, 0)} | ${b.pos} | ${b.neg} |`);
results.bySym = syms;
const out = flag('--json');
if (out) { fs.writeFileSync(out, JSON.stringify(results, null, 1)); console.log('\nwrote', out); }
