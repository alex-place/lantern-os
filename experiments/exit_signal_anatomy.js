'use strict';
/**
 * exit_signal_anatomy.js — HOLD THE DIP-BUY UNTIL AN ACTUAL EXIT SIGNAL, NOT THE BOUNCE
 * (ledger row exit-on-signal-not-bounce-13-windows, 2026-09-29).
 *
 * The armed book sells a washout entry at the bounce (session IBS >= 0.6). The operator asks what
 * the book earns if a position is kept until a real sell signal fires instead. Nothing is replayed:
 * every position the bounce exit sold before 15:50 (harness dumps) is kept past that sale on the
 * same 5m bars until one of these fires, else the 15:50 bar of that day:
 *
 *   F1  MOMENTUM DIED  the brain's own signal exit (lib/auto-trader.js, TRADER_MOMENTUM_EXIT, armed
 *       off), computed with the brain's indicator code on 5m closes: MACD(12,26,9) histogram < 0 AND
 *       close < EMA9 AND RSI(14) < 55, allowed only while the position is up at least 1.5% (0.5 R of
 *       the 3% stop, TRADER_MOMENTUM_MIN_R)
 *   F2  THE BOUNCE FAILS  session IBS back at or under 0.4 after it reached 0.6
 *   F3  F1 with the book's 1% step floor (a floor 1% under the highest whole percent gained since entry)
 *
 * each with the 3% stop under the entry (a bar wholly under the stop fills at its close). Positions
 * that left by a stop, a floor or the 15:50 rule are untouched by the question.
 *
 * Usage: node experiments/exit_signal_anatomy.js <dumpDir> [prefix=floor] [variant=F_armed] [--wins a,b|map] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { macd, rsi, emaSeries } = require(path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'signal-engine', 'indicators'));

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const DIR = positional[0], PREFIX = positional[1] || 'floor', VAR = positional[2] || 'F_armed';
if (!DIR) { console.error('usage: node exit_signal_anatomy.js <dumpDir> [prefix] [variant] [--wins a,b|map] [--json out.json]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const WINS_ARG = flag('--wins') || '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = { q4: 'Q4-25', q1: 'Q1-26', aprjul: 'AprJul-26', julsep: 'JulSep-26' };
const label = (w) => NAMES[w] || (/^\d\dq\d$/.test(w) ? `Q${w[3]}-${w.slice(0, 2)}` : w);
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);
const STOP_PCT = 0.03, SALE_MIN = 950, BAND = 50;
const MOM_MIN = Number(process.env.EXIT_MOM_MIN || 0.015);      // 0.5 R of the 3% stop
const FADE_UP = Number(process.env.EXIT_FADE_UP || 0.6), FADE_DN = Number(process.env.EXIT_FADE_DN || 0.4);
const STEP = Number(process.env.EXIT_STEP || 0.01);
const HISTORY_BARS = 60;                                          // 5m bars before the session: MACD needs 35 closes

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
  all.forEach((b, i) => { b.i = i; if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); });
  const s = { byT, all, sessions };
  book.set(sym, s); return s;
}
function byWindow(items, key) {
  let pos = 0, neg = 0; const per = [];
  for (const w of WINS) { const s = items.filter((r) => r.win === w).reduce((q, r) => q + r[key], 0); per.push(s); if (s > BAND) pos++; else if (s < -BAND) neg++; }
  return { pos, neg, per };
}

/** Walk the rest of the session from the sale bar under one exit rule. Returns the exit price and how. */
function walk(s, entryPx, salePx, saleBar, rest, rule) {
  const stop = entryPx * (1 - STOP_PCT);
  let reached = false, floorLvl = 0, lastMom = null;
  // the session bars before the sale, for the IBS path and the indicator warm-up
  const sess = s.sessions.get(saleBar.day);
  let hi = -Infinity, lo = Infinity;
  for (const b of sess) { if (b.t > saleBar.t) break; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); if (hi > lo && (b.c - lo) / (hi - lo) >= FADE_UP) reached = true; }
  if (rule === 'F3') { const gain = salePx / entryPx - 1; const steps = Math.floor(gain / STEP); if (steps >= 1) floorLvl = entryPx * (1 + steps * STEP); }
  for (const b of rest) {
    // protective levels first: a bar that trades through the stop or the floor fills there (or at its close when wholly below)
    const lvl = Math.max(stop, floorLvl);
    if (b.l <= lvl) return { px: b.h < lvl ? b.c : lvl, how: lvl > stop ? 'floor' : 'stop', min: b.min };
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    const ibs = hi > lo ? (b.c - lo) / (hi - lo) : null;
    if (rule === 'F2') {
      if (ibs != null && ibs >= FADE_UP) reached = true;
      if (reached && ibs != null && ibs <= FADE_DN) return { px: b.c, how: 'fade', min: b.min };
    } else {
      const gain = b.c / entryPx - 1;
      if (rule === 'F3') { const steps = Math.floor(gain / STEP); if (steps >= 1) floorLvl = Math.max(floorLvl, entryPx * (1 + steps * STEP)); }
      if (gain >= MOM_MIN) {
        const closes = s.all.slice(Math.max(0, b.i - HISTORY_BARS - 40), b.i + 1).map((x) => x.c);
        const m = macd(closes); const e9 = emaSeries(closes, 9); const r = rsi(closes);
        lastMom = m ? m.histogram : null;
        if (m && m.histogram < 0 && b.c < e9[e9.length - 1] && (r == null || r < 55)) return { px: b.c, how: 'momentum', min: b.min };
      }
    }
    if (b.min >= SALE_MIN) return { px: b.c, how: 'clock', min: b.min };
  }
  const last = rest.length ? rest[rest.length - 1] : saleBar;
  return { px: last.c, how: 'clock', min: last.min };
}

const rows = []; const skipped = { noBar: 0, flat: 0 };
for (const win of WINS) {
  const f = path.join(DIR, `${PREFIX}_${win}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const x = et(t.exit_ms);
    if (t.why !== 'sell' || x.min >= SALE_MIN) continue;      // the bounce exit only
    const s = load(t.sym);
    const eb = s.byT.get(t.entry_ms), sb = s.byT.get(t.exit_ms);
    if (!eb || !sb) { skipped.noBar++; continue; }
    if (!(Math.abs(t.ret) > 1e-9)) { skipped.flat++; continue; }
    const rest = s.sessions.get(x.day).filter((b) => b.t > t.exit_ms && b.min <= SALE_MIN);
    const value = (t.pnl / t.ret) * (sb.c / eb.c);
    const r = { win, sym: t.sym, day: x.day, lev: LEV.has(t.sym), pnl: t.pnl, value, saleMin: x.min };
    for (const rule of ['F1', 'F2', 'F3']) { const o = walk(s, eb.c, sb.c, sb, rest, rule); r[rule] = value * (o.px / sb.c - 1); r[rule + 'how'] = o.how; r[rule + 'r'] = o.px / sb.c - 1; }
    rows.push(r);
  }
}
console.log(`${rows.length} positions the bounce exit sold before 15:50 (their actual result ${usd(rows.reduce((q, r) => q + r.pnl, 0))}), ${WINS.length} windows; skipped ${JSON.stringify(skipped)}`);
console.log(`rules: F1 momentum died (MACD hist<0, close<EMA9, RSI<55, only up >= ${100 * MOM_MIN}%) | F2 the bounce fails (IBS <= ${FADE_DN} after >= ${FADE_UP}) | F3 = F1 + a ${100 * STEP}% step floor | stop ${100 * STOP_PCT}% under the entry | else 15:50`);
const HEAD = '| rule | bucket | positions | dollars it adds | per position | holds that add | worst | windows it adds | windows it costs | how they end |\n|---|---|---|---|---|---|---|---|---|---|';
function line(rule, name, set) {
  const w = byWindow(set, rule); const tot = set.reduce((q, r) => q + r[rule], 0);
  const how = {}; for (const r of set) how[r[rule + 'how']] = (how[r[rule + 'how']] || 0) + 1;
  console.log(`| ${rule} | ${name} | ${set.length} | ${usd(tot)} | ${pct(mean(set.map((r) => r[rule + 'r'])), 3)} | ${pct(set.length ? set.filter((r) => r[rule] > 0).length / set.length : null, 0)} | ${pct(set.length ? Math.min(...set.map((r) => r[rule + 'r'])) : null, 1)} | ${w.pos} | ${w.neg} | ${Object.entries(how).map(([k, n]) => k + ' ' + n).join(', ')} |`);
  return { rule, name, n: set.length, add: tot, pos: w.pos, neg: w.neg, per: w.per, how };
}
console.log(HEAD);
const res = {};
for (const rule of ['F1', 'F2', 'F3']) {
  res[rule] = { all: line(rule, 'every bounce exit', rows), lev: line(rule, '3x and 2x names', rows.filter((r) => r.lev)), one: line(rule, '1x names', rows.filter((r) => !r.lev)), soxl: line(rule, 'SOXL alone', rows.filter((r) => r.sym === 'SOXL')) };
}
console.log('\nby window, F1 (momentum died): ' + WINS.map((w, i) => `${label(w)} ${usd(res.F1.all.per[i])}`).join(' | '));
console.log('by window, F2 (the bounce fails): ' + WINS.map((w, i) => `${label(w)} ${usd(res.F2.all.per[i])}`).join(' | '));
console.log('by window, F3 (momentum + floor): ' + WINS.map((w, i) => `${label(w)} ${usd(res.F3.all.per[i])}`).join(' | '));
const need = Math.ceil(WINS.length * 11 / 13);
console.log(`-> F1 ${res.F1.all.pos >= need && res.F1.all.add > 0 ? 'CLEARS' : 'does not clear'} the bar (adds in ${res.F1.all.pos} of ${WINS.length}, needs ${need}, total ${usd(res.F1.all.add)})`);
const out = flag('--json');
if (out) { fs.writeFileSync(out, JSON.stringify({ windows: WINS, positions: rows.length, res }, null, 1)); console.log('\nwrote', out); }
