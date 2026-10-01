'use strict';
/**
 * noise_area_anatomy.js — THE NOISE AREA OF ZARATTINI, AZIZ AND BARBON (2024), TWO USES
 * (ledger rows book-entries-under-spy-noise-break and noise-area-momentum-wrappers, 2026-09-30).
 *
 * Source: C. Zarattini, A. Aziz, A. Barbon, "Beat the Market: An Effective Intraday Momentum Strategy for
 * S&P500 ETF (SPY)", SSRN 4824172 / Swiss Finance Institute RP 24-97 (2024). The noise area at time t of
 * session d:
 *   sigma_d(t) = the 14-session average of |price(t) / open - 1| at the same time of day
 *   upper_d(t) = max(open_d, prevClose_d) x (1 + sigma_d(t))     lower_d(t) = min(open_d, prevClose_d) x (1 - sigma_d(t))
 * Deviations, fixed before the run: 5m bars (not minutes); the open proxied by the first 5m bar's midpoint
 * (the caches carry no open); no VWAP (no volume), so the band itself is the trailing stop.
 *
 *   --mode book      tag each book trade (harness dumps) by SPY's state at its entry bar: DOWN / UP / IN
 *   --mode momentum  the paper's entries at the bars closing 10:00 ... 15:30, long-only through 3x wrappers:
 *                    proxy above upper -> buy the long wrapper, below lower -> buy the inverse wrapper; sold at
 *                    the first 5m close back inside the band on its side, else at 15:50; re-entry at a later
 *                    decision time; one position per pair
 *
 * Usage: node experiments/noise_area_anatomy.js --mode book <dumpDir> <prefix> <variant> [--wins map]
 *        node experiments/noise_area_anatomy.js --mode momentum [--pairs SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ,SMH:SOXL:SOXS]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const MODE = flag('--mode') || 'momentum';
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const MAP30 = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort();
const LOOKBACK = 14, MIN_HIST = 10, SALE_MIN = 950, MIN_N = 5;
const DECISIONS = new Set(Array.from({ length: 12 }, (_, k) => 595 + 30 * k));   // bars closing 10:00, 10:30, ..., 15:30
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const memo = new Map();
function et(ms) { let e = memo.get(ms); if (e) return e; const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value; e = { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) }; memo.set(ms, e); return e; }
const dirs = fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_/.test(d));
const book = new Map();
function load(sym) {
  if (book.has(sym)) return book.get(sym);
  const byT = new Map();
  for (const d of dirs) { const f = path.join(CACHE_ROOT, d, sym + '.json'); if (!fs.existsSync(f)) continue; let bars; try { bars = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { continue; } for (const b of bars) { const e = et(b.t); if (e.min < 570 || e.min >= 960) continue; if (!byT.has(b.t)) byT.set(b.t, { t: b.t, c: +b.c, h: +b.h, l: +b.l, day: e.day, min: e.min }); } }
  const sessions = new Map();
  for (const b of [...byT.values()].sort((a, b) => a.t - b.t)) { if (!sessions.has(b.day)) sessions.set(b.day, []); sessions.get(b.day).push(b); }
  const days = [...sessions.keys()].sort();
  const s = { sessions, days, idx: new Map(days.map((d, i) => [d, i])), byT };
  for (const d of days) { const a = sessions.get(d); a.byMin = new Map(a.map((b) => [b.min, b])); a.open = (a[0].h + a[0].l) / 2; a.close = a[a.length - 1].c; }
  book.set(sym, s); return s;
}
const calDays = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
const bandMemo = new Map();
/** The noise band of `sym` on `day`: Map(min -> { upper, lower }) or null without clean history. */
function band(sym, day) {
  const key = sym + ':' + day; if (bandMemo.has(key)) return bandMemo.get(key);
  const s = load(sym); const i = s.idx.get(day); let out = null;
  if (i != null && i > LOOKBACK) {
    const prev = s.days[i - 1], cur = s.sessions.get(day);
    if (calDays(prev, day) <= 5 && calDays(s.days[i - LOOKBACK], day) <= 28 && cur.length >= 60) {
      const prevClose = s.sessions.get(prev).close, hiRef = Math.max(cur.open, prevClose), loRef = Math.min(cur.open, prevClose);
      out = new Map();
      for (const b of cur) {
        const moves = [];
        for (let k = 1; k <= LOOKBACK; k++) { const ss = s.sessions.get(s.days[i - k]); const bb = ss.byMin.get(b.min); if (bb) moves.push(Math.abs(bb.c / ss.open - 1)); }
        if (moves.length < MIN_HIST) continue;
        const sigma = moves.reduce((x, y) => x + y, 0) / moves.length;
        out.set(b.min, { upper: hiRef * (1 + sigma), lower: loRef * (1 - sigma) });
      }
    }
  }
  bandMemo.set(key, out); return out;
}
function stateAt(sym, day, min) {
  const bd = band(sym, day); if (!bd) return null;
  const bb = load(sym).sessions.get(day).byMin.get(min); const lim = bd.get(min); if (!bb || !lim) return null;
  return bb.c > lim.upper ? 'UP' : bb.c < lim.lower ? 'DOWN' : 'IN';
}
function windowDays(win) { const set = new Set(); for (const b of JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, 'oos_' + win, 'SPY.json'), 'utf8'))) { const e = et(b.t); if (e.min >= 570 && e.min < 960) set.add(e.day); } return [...set].sort(); }
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');

/** The momentum leg's trades on a list of windows: { win, day, pair, side, ret, why, at } */
function momentumTrades(wins, PAIRS) {
  const trades = [];
  for (const w of wins) for (const day of windowDays(w)) for (const pr of PAIRS) {
    const bd = band(pr.proxy, day); if (!bd) continue;
    const P = load(pr.proxy).sessions.get(day), U = load(pr.up).sessions.get(day), D = load(pr.dn).sessions.get(day);
    if (!P || !U || !D) continue;
    let pos = null;
    for (const b of P) {
      if (b.min < 595) continue;
      const lim = bd.get(b.min); if (!lim) continue;
      if (pos) {
        const wb = (pos.side === 'up' ? U : D).byMin.get(b.min);
        const back = pos.side === 'up' ? b.c < lim.upper : b.c > lim.lower;
        if (wb && (back || b.min >= SALE_MIN)) { trades.push({ win: w, day, pair: pr.proxy, side: pos.side, ret: wb.c / pos.px - 1, why: b.min >= SALE_MIN ? 'close' : 'band', at: pos.at }); pos = null; }
        if (b.min >= SALE_MIN) break;
        continue;
      }
      if (b.min >= SALE_MIN) break;
      if (!DECISIONS.has(b.min)) continue;
      const side = b.c > lim.upper ? 'up' : b.c < lim.lower ? 'dn' : null;
      if (!side) continue;
      const wb = (side === 'up' ? U : D).byMin.get(b.min); if (!wb) continue;
      pos = { side, px: wb.c, at: b.min + 5 };
    }
  }
  return trades;
}

/** SPY's day type, as in scenario_map.js (looks at the whole day: a label for reporting, never a signal). */
function dayType(day) {
  const s = load('SPY'); const i = s.idx.get(day); if (i == null || i < 61) return null;
  const bars = s.sessions.get(day); if (!bars || bars.length < 60) return null;
  const closes = s.days.map((d) => s.sessions.get(d).close);
  const a = []; for (let k = i - 60; k < i; k++) a.push(Math.abs(closes[k] / closes[k - 1] - 1)); a.sort((x, y) => x - y);
  const mad = (a[29] + a[30]) / 2;
  let hi = -Infinity, lo = Infinity, hiMin = 0, loMin = 0;
  for (const b of bars) { if (b.h > hi) { hi = b.h; hiMin = b.min; } if (b.l < lo) { lo = b.l; loMin = b.min; } }
  const close = bars[bars.length - 1].c, range = (hi - lo) / lo, cl = (close - lo) / (hi - lo);
  if (range < mad) return 'NARROW';
  if (cl >= 0.75 && loMin < 660) return 'RALLY';
  if (cl <= 0.25 && hiMin < 660) return 'DROP';
  if (cl >= 0.6 && loMin >= 660) return 'V_UP';
  if (cl <= 0.4 && hiMin >= 660) return 'FADE';
  return 'MIXED';
}

/** Costs, scenarios and the leg beside the book (ledger row noise-momentum-costs-and-days). */
function portfolio(PAIRS) {
  const [DIR, PREFIX13, PREFIX30, VAR] = positional;
  const NOTIONAL = Number(flag('--notional') || 18000);           // 18% of the 100k replay account per trade
  const COSTS = [0, 3, 5, 10];                                     // bp a round trip
  for (const [surface, wins, prefix] of [['13 scored windows', SCORED13, PREFIX13], ['30 unseen quarters', MAP30, PREFIX30]]) {
    const trades = momentumTrades(wins, PAIRS);
    console.log(`\n=== ${surface} | ${trades.length} trades`);
    // (1) costs
    const gross = trades.reduce((a, t) => a + t.ret, 0) / trades.length;
    console.log(`(1) break-even round-trip cost: ${(1e4 * gross).toFixed(1)} bp a trade`);
    for (const c of COSTS) {
      let pos = 0, neg = 0; for (const w of wins) { const q = trades.filter((t) => t.win === w); if (q.length >= MIN_N) { const m = q.reduce((x, t) => x + t.ret - c / 1e4, 0) / q.length; if (m > 0.0002) pos++; else if (m < -0.0002) neg++; } }
      console.log(`    net of ${String(c).padStart(2)} bp: ${pct(gross - c / 1e4)} a trade, ${usd(trades.length * (gross - c / 1e4) * NOTIONAL)} at ${NOTIONAL / 1000}k a trade, quarters ${pos} / ${neg}`);
    }
    // (2) scenarios
    const byType = {};
    for (const t of trades) { const ty = dayType(t.day) || 'NA'; const e = byType[ty] || (byType[ty] = { n: 0, sum: 0, days: new Set() }); e.n++; e.sum += t.ret; e.days.add(t.day); }
    console.log('(2) by the market\'s day type: ' + ['RALLY', 'DROP', 'V_UP', 'FADE', 'MIXED', 'NARROW', 'NA'].filter((k) => byType[k]).map((k) => `${k} ${byType[k].n} trades ${pct(byType[k].sum / byType[k].n)} each, ${usd(byType[k].sum * NOTIONAL)}`).join(' | '));
    // (3) beside the book: daily P&L series
    const bookDay = new Map();
    for (const w of wins) {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, `${prefix}_${w}.${VAR}.daily.json`), 'utf8')).daily;
      let prev = 100000; for (const r of d) { bookDay.set(r.day, (bookDay.get(r.day) || 0) + (r.acct - prev)); prev = r.acct; }
    }
    for (const c of [0, 5]) {
      const legDay = new Map();
      for (const t of trades) legDay.set(t.day, (legDay.get(t.day) || 0) + (t.ret - c / 1e4) * NOTIONAL);
      const days = [...bookDay.keys()].sort();
      const B = days.map((d) => bookDay.get(d)), L = days.map((d) => legDay.get(d) || 0);
      const mB = B.reduce((a, b) => a + b, 0) / B.length, mL = L.reduce((a, b) => a + b, 0) / L.length;
      const cov = B.reduce((a, b, k) => a + (b - mB) * (L[k] - mL), 0), vB = B.reduce((a, b) => a + (b - mB) ** 2, 0), vL = L.reduce((a, b) => a + (b - mL) ** 2, 0);
      const corr = cov / Math.sqrt(vB * vL);
      // weeks: Monday-anchored calendar weeks
      const wk = (d) => { const t = Date.parse(d + 'T12:00:00Z'); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 86400000).toISOString().slice(0, 10); };
      const weeks = new Map();
      days.forEach((d, k) => { const key = wk(d); const e = weeks.get(key) || { b: 0, l: 0 }; e.b += B[k]; e.l += L[k]; weeks.set(key, e); });
      const W = [...weeks.values()];
      const posB = W.filter((e) => e.b > 0).length / W.length, posC = W.filter((e) => e.b + e.l > 0).length / W.length;
      const worstB = Math.min(...W.map((e) => e.b)), worstC = Math.min(...W.map((e) => e.b + e.l));
      let qB = 0, qC = 0; for (const w of wins) { const wd = new Set(windowDays(w)); let sb = 0, sl = 0; days.forEach((d, k) => { if (wd.has(d)) { sb += B[k]; sl += L[k]; } }); if (sb > 0) qB++; if (sb + sl > 0) qC++; }
      const totB = B.reduce((a, b) => a + b, 0), totL = L.reduce((a, b) => a + b, 0);
      console.log(`(3) net of ${c} bp: daily correlation book/leg ${corr.toFixed(2)} | book ${usd(totB)}, leg ${usd(totL)}, together ${usd(totB + totL)} | positive weeks ${pct(posB, 0)} -> ${pct(posC, 0)} of ${W.length} | worst week ${usd(worstB)} -> ${usd(worstC)} | positive quarters ${qB} -> ${qC} of ${wins.length}`);
      // the drop days: does the leg pay when the book loses?
      if (c === 0) {
        const dropDays = days.filter((d) => dayType(d) === 'DROP');
        const bd = dropDays.reduce((a, d) => a + (bookDay.get(d) || 0), 0), ld = dropDays.reduce((a, d) => a + (legDay.get(d) || 0), 0);
        console.log(`    on the ${dropDays.length} DROP days: book ${usd(bd)}, leg ${usd(ld)}`);
      }
    }
  }
}

// Required as a module (experiments/noise_leg_variants.js), the file only exports its measuring functions.
module.exports = { load, band, stateAt, windowDays, momentumTrades, dayType, SCORED13, MAP30 };
if (require.main !== module) { /* library use: no command line */ } else if (MODE === 'book') {
  const [DIR, PREFIX, VAR] = positional;
  const WINS = flag('--wins') === 'map' ? MAP30 : SCORED13;
  const tr = [];
  for (const w of WINS) {
    for (const t of JSON.parse(fs.readFileSync(path.join(DIR, `${PREFIX}_${w}.${VAR}.json`), 'utf8'))) {
      if (t.owner !== 'S') continue; const e = et(t.entry_ms); const st = stateAt('SPY', e.day, e.min);
      tr.push({ ...t, win: w, st: st || 'NA', inverse: /^(SQQQ|SOXS|SPXS|TZA)$/.test(t.sym) });
    }
  }
  const tot = tr.reduce((a, t) => a + t.pnl, 0);
  console.log(`${WINS.length} windows | ${tr.length} book trades | ${usd(tot)}`);
  console.log('| SPY at entry | trades | P&L | per trade | gain | windows net negative (of those with trades) | longs / inverses P&L |');
  console.log('|---|---|---|---|---|---|---|');
  const res = {};
  for (const st of ['DOWN', 'IN', 'UP', 'NA']) {
    const a = tr.filter((t) => t.st === st); const pnl = a.reduce((x, t) => x + t.pnl, 0);
    let neg = 0, withT = 0; for (const w of WINS) { const q = a.filter((t) => t.win === w); if (q.length) { withT++; if (q.reduce((x, t) => x + t.pnl, 0) < -50) neg++; } }
    const L = a.filter((t) => !t.inverse).reduce((x, t) => x + t.pnl, 0), I = a.filter((t) => t.inverse).reduce((x, t) => x + t.pnl, 0);
    res[st] = { n: a.length, pnl, neg, withT };
    console.log(`| ${st} | ${a.length} | ${usd(pnl)} | ${pct(a.length ? a.reduce((x, t) => x + t.ret, 0) / a.length : null)} | ${pct(a.length ? a.filter((t) => t.pnl > 0).length / a.length : null, 0)} | ${neg} of ${withT} | ${usd(L)} / ${usd(I)} |`);
  }
  const o = flag('--json'); if (o) fs.writeFileSync(o, JSON.stringify(res, null, 1));
} else {
  const PAIRS = String(flag('--pairs') || 'SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ,SMH:SOXL:SOXS').split(',').map((p) => { const [proxy, up, dn] = p.split(':'); return { proxy, up, dn }; });
  const results = {};
  if (MODE === 'portfolio') { portfolio(PAIRS); process.exit(0); }
  for (const [surface, wins] of [['scored', SCORED13], ['map', MAP30]]) {
    const trades = momentumTrades(wins, PAIRS);
    results[surface] = {};
    console.log(`\n=== ${surface === 'scored' ? '13 scored windows' : '30 unseen quarters'} | pairs ${PAIRS.map((p) => p.proxy + '>' + p.up + '/' + p.dn).join(' ')}`);
    console.log('| set | trades | mean per trade | sum | gain | quarters + / - (>=5 trades) | up side sum (n) | down side sum (n) | sold by the band |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const [name, pick] of [['pooled', () => true], ...PAIRS.map((p) => [p.proxy, (t) => t.pair === p.proxy])]) {
      const a = trades.filter(pick); const sum = a.reduce((x, t) => x + t.ret, 0);
      let pos = 0, neg = 0; for (const w of wins) { const q = a.filter((t) => t.win === w); if (q.length >= MIN_N) { const m = q.reduce((x, t) => x + t.ret, 0) / q.length; if (m > 0.0002) pos++; else if (m < -0.0002) neg++; } }
      const up = a.filter((t) => t.side === 'up'), dn = a.filter((t) => t.side === 'dn');
      results[surface][name] = { n: a.length, mean: a.length ? sum / a.length : null, sum, pos, neg, upSum: up.reduce((x, t) => x + t.ret, 0), dnSum: dn.reduce((x, t) => x + t.ret, 0) };
      console.log(`| ${name} | ${a.length} | ${pct(a.length ? sum / a.length : null)} | ${pct(sum, 1)} | ${pct(a.length ? a.filter((t) => t.ret > 0).length / a.length : null, 0)} | ${pos} / ${neg} | ${pct(results[surface][name].upSum, 1)} (${up.length}) | ${pct(results[surface][name].dnSum, 1)} (${dn.length}) | ${pct(a.length ? a.filter((t) => t.why === 'band').length / a.length : null, 0)} |`);
    }
  }
  const o = flag('--json'); if (o) fs.writeFileSync(o, JSON.stringify(results, null, 1));
}
