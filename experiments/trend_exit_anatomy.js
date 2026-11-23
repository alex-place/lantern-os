'use strict';
/**
 * trend_exit_anatomy.js — A MORE ACCURATE MOMENTUM-DEATH EXIT FOR THE TREND-DAY ENTRY?
 * (ledger row momentum-death-exit-variants-trend-entries, 2026-09-30).
 *
 * The trend-day entry (V0 of trend_variants_anatomy.js) sells at 15:50. The brain's momentum-death
 * exit (lib/auto-trader.js: 5m MACD(12,26,9) histogram < 0 AND close < EMA9 AND RSI(14) < 55, in profit
 * only) could sell a trend that has died earlier, or cut a winner that only paused. Pre-declared
 * variants, each with the 8% stop:
 *
 *   X0  the 15:50 sale (baseline)
 *   M0  the brain's signal on 5m closes, in profit only
 *   M1  M0 on 15m closes (a 15m bar completes at :15/:30/:45/:00)
 *   M2  M0 holding on two consecutive 5m closes
 *   M3  a structure break: close < EMA20 and EMA9 < EMA20 on 5m, no profit gate
 *   M4  M0 confirmed by the market: for a long, the same death on its proxy (QQQ for semis and Nasdaq
 *       names, SPY otherwise); for an inverse, its underlying proxy's momentum RISING (histogram > 0
 *       and close above its EMA9)
 *   M5  M0 without the profit gate
 *
 * Indicators use the brain's own functions (lib/signal-engine/indicators.js) on the last 150 regular-
 * session 5m closes (the brain reads a month of 5m bars that include pre/post market: close, not equal).
 * A signal is read on a completed bar's close and sells at that close.
 *
 * Also reported: firing ACCURACY (the share of firings after which the 15:50 price was lower) and the
 * money a firing saved against the 15:50 sale, split by the market at the firing (SPY above or below
 * its first regular-session 5m close) and by long or inverse.
 *
 * Usage: node experiments/trend_exit_anatomy.js [--syms SOXL] [--wins scored|map] [--json out.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { macd, rsi, emaSeries } = require(path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'signal-engine', 'indicators'));

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SYMS = String(flag('--syms') || 'SOXL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const MAP30 = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort();
const SURFACES = flag('--wins') === 'map' ? { map: MAP30 } : flag('--wins') === 'scored' ? { scored: SCORED13 } : { scored: SCORED13, map: MAP30 };
const LEV = new Set(['SOXL', 'TNA', 'SPXL', 'UPRO', 'TQQQ', 'NUGT', 'JNUG', 'UCO', 'SQQQ', 'SOXS', 'SPXS', 'TZA']);
const INVERSE_PROXY = { SQQQ: 'QQQ', SOXS: 'SMH', SPXS: 'SPY', TZA: 'IWM' };
const LONG_PROXY = { SOXL: 'QQQ', TQQQ: 'QQQ', SMH: 'QQQ', QQQ: 'QQQ', XLK: 'QQQ' };
const CHECKS = [625, 685, 775], TOP = 0.8, RANGE_K = 1.0, HARD_STOP = 0.08, SALE_MIN = 950, MIN_N = 5, WIN = 150;
const VARS = ['X0', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5'];

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
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  all.forEach((b, i) => { b.i = i; });
  const sessions = new Map();
  for (const b of all) { if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); }
  const days = [...sessions.keys()].sort();
  // 15m bars: groups of three 5m bars from 09:30; a 15m bar completes with its third 5m bar
  const q15 = [];
  for (const d of days) {
    const s = sessions.get(d);
    for (let g = 570; g < 960; g += 15) { const grp = s.filter((b) => b.min >= g && b.min < g + 15); if (grp.length) q15.push({ t: grp[grp.length - 1].t, c: grp[grp.length - 1].c, endsAtMin: g + 15, day: d }); }
  }
  const s = { all, sessions, days, idx: new Map(days.map((d, i) => [d, i])), close: days.map((d) => { const a = sessions.get(d); return a[a.length - 1].c; }), q15, byT: new Map(all.map((b) => [b.t, b])) };
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
  a.sort((x, y) => x - y); return (a[29] + a[30]) / 2;
}
/** The momentum read on a close series ending at a bar: { dead, alive, below20 } */
function readMomentum(closes) {
  if (closes.length < 40) return null;
  const m = macd(closes); const e9 = emaSeries(closes, 9); const e20 = emaSeries(closes, 20); const r = rsi(closes);
  if (!m || !e9.length || !e20.length) return null;
  const last = closes[closes.length - 1], E9 = e9[e9.length - 1], E20 = e20[e20.length - 1];
  return { dead: m.histogram < 0 && last < E9 && (r == null || r < 55), alive: m.histogram > 0 && last > E9, structureBreak: last < E20 && E9 < E20 };
}
const closesTo = (s, bar) => s.all.slice(Math.max(0, bar.i - WIN + 1), bar.i + 1).map((b) => b.c);
const memoRead = new Map();
function readAt(sym, bar) {
  const k = sym + ':' + bar.t; if (memoRead.has(k)) return memoRead.get(k);
  const v = readMomentum(closesTo(load(sym), bar)); memoRead.set(k, v); return v;
}
function read15(sym, bar) {
  // the latest completed 15m bar at or before this 5m bar's close
  const s = load(sym); const e = et(bar.t);
  const endMin = e.min + 5;
  if ((endMin - 570) % 15 !== 0) return null;                  // only evaluate when a 15m bar has just completed
  const qi = s.q15.findIndex((q) => q.t === bar.t);
  if (qi < 40) return null;
  return readMomentum(s.q15.slice(Math.max(0, qi - WIN + 1), qi + 1).map((q) => q.c));
}

/** One entry walked forward under every variant. */
function walk(sym, bars, entryIdx, inverse) {
  const s = load(sym);
  const ent = bars[entryIdx];
  const proxy = inverse ? INVERSE_PROXY[sym] : (LONG_PROXY[sym] || 'SPY');
  const ps = load(proxy);
  const spy = load('SPY'); const spySess = spy.sessions.get(ent.day) || []; const spyOpen = spySess.length ? spySess[0].c : null;
  const hard = ent.c * (1 - HARD_STOP);
  const out = {};
  const prevDead = { M2: false };
  const done = {};
  let saleBar = null;
  for (let j = entryIdx + 1; j < bars.length; j++) {
    const b = bars[j];
    // the stop first, for every variant still open
    if (b.l <= hard) { const px = b.h < hard ? b.c : hard; for (const v of VARS) if (!done[v]) { out[v] = { px, how: 'stop', min: b.min }; done[v] = true; } break; }
    const gain = b.c / ent.c - 1;
    const r = readAt(sym, b);
    if (r) {
      if (!done.M0 && gain > 0 && r.dead) { out.M0 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M0 = true; }
      if (!done.M2) { if (gain > 0 && r.dead && prevDead.M2) { out.M2 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M2 = true; } prevDead.M2 = gain > 0 && r.dead; }
      if (!done.M3 && r.structureBreak) { out.M3 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M3 = true; }
      if (!done.M5 && r.dead) { out.M5 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M5 = true; }
      if (!done.M4 && gain > 0 && r.dead) {
        const pb = ps.byT.get(b.t); const pr = pb ? readAt(proxy, pb) : null;
        if (pr && (inverse ? pr.alive : pr.dead)) { out.M4 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M4 = true; }
      }
    }
    if (!done.M1 && gain > 0) { const r15 = read15(sym, b); if (r15 && r15.dead) { out.M1 = { px: b.c, how: 'signal', min: b.min, t: b.t }; done.M1 = true; } }
    if (b.min >= SALE_MIN) { saleBar = b; break; }
  }
  const last = saleBar || bars[bars.length - 1];
  for (const v of VARS) if (!done[v]) out[v] = { px: last.c, how: 'close', min: last.min };
  // accuracy inputs: the 15:50 price, the market at the firing
  for (const v of VARS) {
    const o = out[v];
    o.ret = o.px / ent.c - 1;
    if (o.how === 'signal') {
      o.saved = (o.px - last.c) / ent.c;                      // > 0: selling at the signal beat holding to 15:50
      const sb = spy.byT.get(o.t); o.spyUp = spyOpen && sb ? sb.c >= spyOpen : null;
    }
  }
  return out;
}

const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const results = {};
for (const [surface, wins] of Object.entries(SURFACES)) {
  const rows = [];
  for (const w of wins) for (const sym of SYMS) {
    const s = load(sym); const inverse = !!INVERSE_PROXY[sym];
    for (const day of windowDays(w)) {
      const i = s.idx.get(day); if (i == null) continue;
      const bars = s.sessions.get(day); if (!bars || bars.length < 60) continue;
      const mad = mad60(s, i, sym); if (!(mad > 0)) continue;
      let hi = -Infinity, lo = Infinity, ei = -1;
      for (let k = 0; k < bars.length; k++) { const b = bars[k]; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); if (CHECKS.includes(b.min) && hi > lo && (b.c - lo) / (hi - lo) >= TOP && (hi - lo) / lo >= RANGE_K * mad) { ei = k; break; } }
      if (ei < 0) continue;
      rows.push({ win: w, sym, day, inverse, ...walk(sym, bars, ei, inverse) });
    }
  }
  results[surface] = {};
  console.log(`\n=== ${surface === 'scored' ? '13 scored windows' : '30 unseen quarters'} | ${SYMS.join(',')} | ${rows.length} entries`);
  console.log('| exit | mean per entry | sum | gain | quarters + / - | fired | accuracy (15:50 lower) | saved per firing | accuracy, SPY up / down at firing |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const v of VARS) {
    const rets = rows.map((r) => r[v].ret);
    let pos = 0, neg = 0;
    for (const w of wins) { const a = rows.filter((r) => r.win === w).map((r) => r[v].ret); if (a.length >= MIN_N) { const m = mean(a); if (m > 0.0002) pos++; else if (m < -0.0002) neg++; } }
    const fired = rows.filter((r) => r[v].how === 'signal');
    const acc = fired.length ? fired.filter((r) => r[v].saved > 0).length / fired.length : null;
    const up = fired.filter((r) => r[v].spyUp === true), dn = fired.filter((r) => r[v].spyUp === false);
    const accOf = (a) => (a.length ? `${Math.round(100 * a.filter((r) => r[v].saved > 0).length / a.length)}% of ${a.length}` : '-');
    results[surface][v] = { n: rows.length, mean: mean(rets), sum: rets.reduce((a, b) => a + b, 0), pos, neg, fired: fired.length, acc, saved: mean(fired.map((r) => r[v].saved)) };
    console.log(`| ${v} | ${pct(mean(rets))} | ${pct(rets.reduce((a, b) => a + b, 0), 1)} | ${pct(rets.length ? rets.filter((x) => x > 0).length / rets.length : null, 0)} | ${pos} / ${neg} | ${fired.length} | ${acc == null ? '-' : Math.round(100 * acc) + '%'} | ${pct(mean(fired.map((r) => r[v].saved)))} | ${accOf(up)} / ${accOf(dn)} |`);
  }
}
if (Object.keys(results).length === 2) {
  const b = { s: results.scored.X0, m: results.map.X0 };
  console.log('\nBAR to replace the 15:50 sale: higher mean AND higher sum on both surfaces, positive quarters >= X0 on both');
  for (const v of VARS.slice(1)) {
    const s = results.scored[v], m = results.map[v];
    const ok = s.mean > b.s.mean && m.mean > b.m.mean && s.sum > b.s.sum && m.sum > b.m.sum && s.pos >= b.s.pos && m.pos >= b.m.pos;
    console.log(`  ${v}: ${ok ? 'CLEARS' : 'does not clear'} (mean ${pct(s.mean)} / ${pct(m.mean)} against ${pct(b.s.mean)} / ${pct(b.m.mean)}; quarters up ${s.pos} / ${m.pos} against ${b.s.pos} / ${b.m.pos})`);
  }
}
const outF = flag('--json');
if (outF) fs.writeFileSync(outF, JSON.stringify(results, null, 1));
