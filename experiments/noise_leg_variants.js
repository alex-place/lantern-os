'use strict';
// experiments/noise_leg_variants.js — refinements of the noise-area momentum leg of noise_area_anatomy.js (2026-09-30),
// measured like the rule itself: gross and net of a per-symbol round-trip cost model, by the market's day type
// (scenario_map.js), and beside the armed book's daily mark-to-market series from replay_two_sleeve.js dumps.
//   V0  the rule as measured (noise_area_anatomy.js momentum mode)
//   F1  first break only: one entry per pair per day, no re-entry after a band exit
//   F2  breadth: enter only when at least 2 of the 3 proxies are outside their bands on the same side at that bar
//   F3  a wider band: sigma x 1.5
//   F4  the paper's trailing stop, a time-weighted session average standing in for VWAP (no volume in the caches):
//       the long wrapper is sold when the proxy closes below max(upper, TWAP), the inverse above min(lower, TWAP)
//   DN / UP  only the inverse / only the long entries (the drop-day hedge question); DNb = DN when at least 2 of the
//       3 proxies are below their lower bands (a broad selloff); the g suffix = under the G1 gate
//   G1  V0 traded only when SPY's 20-session annualized realized volatility (log close-to-close, known at the open)
//       is >= 16%, the scenario map's definition (intraday momentum is stronger on volatile days: Gao, Han, Li and Zhou
//       2018, JFE 'Market intraday momentum'); G1F2 = F2 under the same gate
// --sweep: V0 net by volatility threshold (0..25%) and the gated / ungated net per window, every threshold reported.
// Usage: node experiments/noise_leg_variants.js <dumpDir> [--prefix13 trend] [--prefix30 trendmap] [--book T_armed]
//          [--only V0,F1] [--sweep] [--json out.json]
const fs = require('fs');
const path = require('path');
const lib = require('./noise_area_anatomy.js');
const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const DIR = args[0];
const PAIRS = [{ proxy: 'SPY', up: 'UPRO', dn: 'SPXS' }, { proxy: 'QQQ', up: 'TQQQ', dn: 'SQQQ' }, { proxy: 'SMH', up: 'SOXL', dn: 'SOXS' }];
const COST = { UPRO: 3, TQQQ: 3, SOXL: 3, SQQQ: 9, SOXS: 9, SPXS: 12 };
const NOTIONAL = 18000;
const SALE_MIN = 950, LOOKBACK = 14, MIN_HIST = 10;
const DECISIONS = new Set(Array.from({ length: 12 }, (_, k) => 595 + 30 * k));
const S13 = ['q4', 'q1', 'aprjul', 'julsep', '25q1', '25q2', '25q3', '24q3', '24q4', '22q2', '22q3', '23q1', '23q3'];
const MAP30 = fs.readdirSync(require('os').tmpdir()).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !S13.includes(w)).sort();
const calDays = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;

const bandMemo = new Map();
function bandK(sym, day, k) {                                // Map(min -> { upper, lower, twap, c }) or null
  const key = sym + ':' + day + ':' + k; if (bandMemo.has(key)) return bandMemo.get(key);
  const s = lib.load(sym); const i = s.idx.get(day); let out = null;
  if (i != null && i > LOOKBACK) {
    const prev = s.days[i - 1], cur = s.sessions.get(day);
    if (calDays(prev, day) <= 5 && calDays(s.days[i - LOOKBACK], day) <= 28 && cur.length >= 60) {
      const prevClose = s.sessions.get(prev).close, hiRef = Math.max(cur.open, prevClose), loRef = Math.min(cur.open, prevClose);
      out = new Map(); let csum = 0, cn = 0;
      for (const b of cur) {
        csum += b.c; cn++;
        const moves = [];
        for (let j = 1; j <= LOOKBACK; j++) { const ss = s.sessions.get(s.days[i - j]); const bb = ss.byMin.get(b.min); if (bb) moves.push(Math.abs(bb.c / ss.open - 1)); }
        if (moves.length < MIN_HIST) continue;
        const sg = k * moves.reduce((x, y) => x + y, 0) / moves.length;
        out.set(b.min, { upper: hiRef * (1 + sg), lower: loRef * (1 - sg), twap: csum / cn, c: b.c });
      }
    }
  }
  bandMemo.set(key, out); return out;
}
const volMemo = new Map();
function spyHiVol(day) {
  if (volMemo.has(day)) return volMemo.get(day);
  const s = lib.load('SPY'); const i = s.idx.get(day); let v = null;
  if (i != null && i >= 21) {
    const rets = []; for (let k = i - 20; k < i; k++) rets.push(Math.log(s.sessions.get(s.days[k]).close / s.sessions.get(s.days[k - 1]).close));
    const m = rets.reduce((x, y) => x + y, 0) / rets.length; v = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1) * 252) >= 0.16;
  }
  volMemo.set(day, v); return v;
}
const stateOf = (lim) => (!lim ? null : lim.c > lim.upper ? 'up' : lim.c < lim.lower ? 'dn' : 'in');

function legTrades(wins, opt) {
  const k = opt.k || 1, trades = [];
  for (const w of wins) for (const day of lib.windowDays(w)) {
    if (opt.volGate === 'hi' && spyHiVol(day) !== true) continue;
    const bands = Object.fromEntries(PAIRS.map((p) => [p.proxy, bandK(p.proxy, day, k)]));
    for (const pr of PAIRS) {
      const bd = bands[pr.proxy]; if (!bd) continue;
      const P = lib.load(pr.proxy).sessions.get(day), U = lib.load(pr.up).sessions.get(day), D = lib.load(pr.dn).sessions.get(day);
      if (!P || !U || !D) continue;
      let pos = null, entries = 0;
      for (const b of P) {
        if (b.min < 595) continue;
        const lim = bd.get(b.min); if (!lim) continue;
        if (pos) {
          const wb = (pos.side === 'up' ? U : D).byMin.get(b.min);
          const stopUp = opt.twap ? Math.max(lim.upper, lim.twap) : lim.upper, stopDn = opt.twap ? Math.min(lim.lower, lim.twap) : lim.lower;
          const back = pos.side === 'up' ? b.c < stopUp : b.c > stopDn;
          if (wb && (back || b.min >= SALE_MIN)) { trades.push({ win: w, day, pair: pr.proxy, side: pos.side, sym: pos.side === 'up' ? pr.up : pr.dn, ret: wb.c / pos.px - 1, why: b.min >= SALE_MIN ? 'close' : 'band' }); pos = null; }
          if (b.min >= SALE_MIN) break;
          continue;
        }
        if (b.min >= SALE_MIN) break;
        if (!DECISIONS.has(b.min)) continue;
        if (opt.firstOnly && entries >= 1) break;
        const side = stateOf(lim); if (side !== 'up' && side !== 'dn') continue;
        if (opt.side && side !== opt.side) continue;
        if ((opt.confirm || 1) > 1) {
          const agree = PAIRS.filter((q) => stateOf(bands[q.proxy] && bands[q.proxy].get(b.min)) === side).length;
          if (agree < opt.confirm) continue;
        }
        const wb = (side === 'up' ? U : D).byMin.get(b.min); if (!wb) continue;
        pos = { side, px: wb.c }; entries++;
      }
    }
  }
  return trades;
}

function volOf(day) { const s = lib.load('SPY'); const i = s.idx.get(day); if (i == null || i < 21) return null; const r = []; for (let k = i - 20; k < i; k++) r.push(Math.log(s.sessions.get(s.days[k]).close / s.sessions.get(s.days[k - 1]).close)); const m = r.reduce((x, y) => x + y, 0) / r.length; return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1) * 252); }
function sweep() {
  for (const [name, wins] of [['13 scored windows', S13], ['30 unseen quarters', MAP30]]) {
    const tr = legTrades(wins, {}).map((t) => ({ ...t, net: netRet(t), vol: volOf(t.day) }));
    console.log(`
=== ${name}: V0 net by SPY 20-session volatility threshold (pp at 18k a trade)`);
    for (const th of [0, 0.12, 0.14, 0.16, 0.18, 0.20, 0.25]) {
      const a = tr.filter((t) => t.vol != null && t.vol >= th); const n = a.reduce((x, t) => x + t.net, 0);
      let p = 0, q = 0; for (const w of wins) { const b = a.filter((t) => t.win === w); if (!b.length) continue; if (b.reduce((x, t) => x + t.net, 0) > 0) p++; else q++; }
      console.log(`  vol >= ${(100 * th).toFixed(0).padStart(2)}%: ${String(a.length).padStart(4)} trades, ${pct(n / Math.max(1, a.length))} a trade, ${(n * NOTIONAL / 1000).toFixed(1).padStart(6)}pp, windows with gated trades net + / - ${p} / ${q}`);
    }
    console.log('  per window at 16%: gated sessions / sessions, gated trades, gated net pp, ungated net pp');
    console.log('  ' + wins.map((w) => { const days = lib.windowDays(w); const a = tr.filter((t) => t.win === w); const g = a.filter((t) => (t.vol || 0) >= 0.16), o = a.filter((t) => !((t.vol || 0) >= 0.16)); return `${w} ${days.filter((d) => (volOf(d) || 0) >= 0.16).length}/${days.length} ${g.length} ${(g.reduce((x, t) => x + t.net, 0) * NOTIONAL / 1000).toFixed(1)} ${(o.reduce((x, t) => x + t.net, 0) * NOTIONAL / 1000).toFixed(1)}`; }).join(' | '));
  }
}
const VARIANTS = { V0: {}, F1: { firstOnly: true }, F2: { confirm: 2 }, F3: { k: 1.5 }, F4: { twap: true }, G1: { volGate: 'hi' }, G1F2: { volGate: 'hi', confirm: 2 },
  DN: { side: 'dn' }, UP: { side: 'up' }, DNg: { side: 'dn', volGate: 'hi' }, UPg: { side: 'up', volGate: 'hi' }, DNb: { side: 'dn', confirm: 2 }, DNbg: { side: 'dn', confirm: 2, volGate: 'hi' } };
const ONLY = flag('--only') ? flag('--only').split(',') : Object.keys(VARIANTS);
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const netRet = (t) => t.ret - COST[t.sym] / 1e4;
const wk = (d) => { const t = Date.parse(d + 'T12:00:00Z'); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 86400000).toISOString().slice(0, 10); };
const out = {};
const BOOK = flag('--book') || 'T_armed';
if (args.includes('--sweep')) { sweep(); process.exit(0); }
for (const [surface, wins, prefix] of [['13w', S13, flag('--prefix13') || 'trend'], ['30q', MAP30, flag('--prefix30') || 'trendmap']]) {
  const bookDay = new Map();
  for (const w of wins) { const d = JSON.parse(fs.readFileSync(path.join(DIR, `${prefix}_${w}.${BOOK}.daily.json`), 'utf8')).daily; let prev = 100000; for (const r of d) { bookDay.set(r.day, (bookDay.get(r.day) || 0) + (r.acct - prev)); prev = r.acct; } }
  const days = [...bookDay.keys()].sort();
  console.log(`\n=== ${surface === '13w' ? '13 scored windows' : '30 unseen quarters'}`);
  console.log('| variant | trades | gross / trade | net / trade | net sum (pp at 18k) | windows net + | RALLY+DROP net / trade | other days net / trade | together: positive weeks | worst week | windows + |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  // the book alone, for the reference line
  {
    const W = new Map(); for (const d of days) W.set(wk(d), (W.get(wk(d)) || 0) + bookDay.get(d));
    const V = [...W.values()]; let q = 0; for (const w of wins) { const wd = new Set(lib.windowDays(w)); let s = 0; for (const d of days) if (wd.has(d)) s += bookDay.get(d); if (s > 0) q++; }
    console.log(`| book alone | - | - | - | ${(V.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} | - | - | - | ${pct(V.filter((x) => x > 0).length / V.length, 0)} of ${V.length} | ${usd(Math.min(...V))} | ${q} of ${wins.length} |`);
  }
  out[surface] = {};
  for (const name of ONLY) {
    const tr = legTrades(wins, VARIANTS[name]);
    const g = tr.reduce((a, t) => a + t.ret, 0), n = tr.reduce((a, t) => a + netRet(t), 0);
    let wpos = 0; for (const w of wins) { const s = tr.filter((t) => t.win === w).reduce((a, t) => a + netRet(t), 0); if (s > 0) wpos++; }
    const big = tr.filter((t) => ['RALLY', 'DROP'].includes(lib.dayType(t.day))), rest = tr.filter((t) => !['RALLY', 'DROP'].includes(lib.dayType(t.day)));
    const legDay = new Map(); for (const t of tr) legDay.set(t.day, (legDay.get(t.day) || 0) + netRet(t) * NOTIONAL);
    const W = new Map(); for (const d of days) W.set(wk(d), (W.get(wk(d)) || 0) + bookDay.get(d) + (legDay.get(d) || 0));
    const V = [...W.values()];
    let q = 0; for (const w of wins) { const wd = new Set(lib.windowDays(w)); let s = 0; for (const d of days) if (wd.has(d)) s += bookDay.get(d) + (legDay.get(d) || 0); if (s > 0) q++; }
    const bySym = {}; for (const t of tr) { const e = bySym[t.sym] || (bySym[t.sym] = { n: 0, net: 0 }); e.n++; e.net += netRet(t); }
    out[surface][name] = { n: tr.length, gross: g / tr.length, net: n / tr.length, netPp: n * NOTIONAL / 1000, wpos, bigNet: big.reduce((a, t) => a + netRet(t), 0) / big.length, restNet: rest.reduce((a, t) => a + netRet(t), 0) / rest.length,
      posWeeks: V.filter((x) => x > 0).length / V.length, worstWeek: Math.min(...V), q, bySym };
    const o = out[surface][name];
    console.log(`| ${name} | ${o.n} | ${pct(o.gross)} | ${pct(o.net)} | ${o.netPp.toFixed(1)} | ${wpos} of ${wins.length} | ${pct(o.bigNet)} (${big.length}) | ${pct(o.restNet)} (${rest.length}) | ${pct(o.posWeeks, 0)} | ${usd(o.worstWeek)} | ${q} of ${wins.length} |`);
  }
  { const tr = legTrades(wins, {}); for (const [lab, pick] of [['gate days (SPY vol >= 16%)', (t) => spyHiVol(t.day) === true], ['other days', (t) => spyHiVol(t.day) !== true]]) { const a = tr.filter(pick); const n = a.reduce((x, t) => x + netRet(t), 0); console.log(`  V0 on ${lab}: ${a.length} trades, net ${pct(n / a.length)} a trade, ${(n * NOTIONAL / 1000).toFixed(1)}pp`); } }
  { const dd = days.filter((d) => lib.dayType(d) === 'DROP'); const bk = dd.reduce((a, d) => a + bookDay.get(d), 0); console.log(`  book on its ${dd.length} DROP days: ${usd(bk)}`); for (const name of ONLY) { const tr = legTrades(wins, VARIANTS[name]); const ld = tr.filter((t) => lib.dayType(t.day) === 'DROP').reduce((a, t) => a + netRet(t) * NOTIONAL, 0); console.log(`  ${name} on those days, net: ${usd(ld)} (${(100 * ld / Math.max(1, -bk)).toFixed(0)}% of the book's loss)`); } }
  for (const name of ONLY) console.log(`  ${name} net by symbol: ` + Object.entries(out[surface][name].bySym).map(([s, e]) => `${s} ${e.n} ${pct(e.net / e.n)}`).join(' | '));
}
const o = flag('--json'); if (o) fs.writeFileSync(o, JSON.stringify(out, null, 1));
