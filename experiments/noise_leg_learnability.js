'use strict';
/**
 * experiments/noise_leg_learnability.js — can ANY information available at the moment of entry tell the noise-area leg's
 * winning entries from its losing ones? (ledger row noise-leg-learnability-holdout, 2026-10-01)
 *
 * The question behind it: would a "brain" (a model, or an AI reading the same screen) supply the judgment the rules lack?
 * Hindsight cannot reach this test: every feature is computed from bars at or before the entry bar, the learners are fit
 * on entries before 2024-07-01 and scored on entries from 2024-07-01 on.
 *
 * Events: every entry of the rule as measured (noise_area_anatomy.js momentumTrades) on both surfaces; outcome = the net
 * return under the per-symbol cost model (UPRO / TQQQ / SOXL 3 bp, SQQQ / SOXS 9, SPXS 12 a round trip).
 * Features (17, "aligned" = multiplied by the side, +1 long wrapper / -1 inverse, so "with the trade" is positive):
 *   side, pair (3 one-hot), decision minute, depth beyond the band in sigmas, aligned gap, aligned move from the open,
 *   session range so far / the 14-session mean full-day range, breadth (proxies outside on the same side), SPY 20-session
 *   realized volatility, aligned prior-day return, aligned 5-day return, re-entries already taken in the pair today,
 *   whether the previous entry today lost, aligned TLT and GLD moves from their opens, aligned 200-session regime, weekday.
 * Learners: L2 logistic regression on "net return > 0"; a nearest-neighbour memory (k = 50 most similar training entries
 * on standardized features, predicting their mean net return: "how did situations like this one turn out").
 * Baselines on the same test entries: the volatility-gate label (SPY 20-session vol >= 16%) and breadth >= 2.
 *
 * Usage: node experiments/noise_leg_learnability.js [--split 2024-07-01] [--k 50]
 */
const lib = require('./noise_area_anatomy.js');
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SPLIT = flag('--split', '2024-07-01');
const K = Number(flag('--k', 50));
const PAIRS = [{ proxy: 'SPY', up: 'UPRO', dn: 'SPXS' }, { proxy: 'QQQ', up: 'TQQQ', dn: 'SQQQ' }, { proxy: 'SMH', up: 'SOXL', dn: 'SOXS' }];
const COST = { UPRO: 3, TQQQ: 3, SOXL: 3, SQQQ: 9, SOXS: 9, SPXS: 12 };
const symOf = (t) => { const p = PAIRS.find((x) => x.proxy === t.pair); return t.side === 'up' ? p.up : p.dn; };

// ---- per-symbol day context, from the same session store the rule uses
const ctxMemo = new Map();
function dayCtx(sym, day) {
  const key = sym + ':' + day; if (ctxMemo.has(key)) return ctxMemo.get(key);
  const s = lib.load(sym); const i = s.idx.get(day); let out = null;
  if (i != null && i >= 1) {
    const cur = s.sessions.get(day), prev = s.sessions.get(s.days[i - 1]);
    const closeAt = (k) => (k >= 0 && k < s.days.length ? s.sessions.get(s.days[k]).close : null);
    const ranges = []; for (let k = Math.max(0, i - 14); k < i; k++) { const a = s.sessions.get(s.days[k]); const hi = Math.max(...a.map((b) => b.h)), lo = Math.min(...a.map((b) => b.l)); ranges.push((hi - lo) / lo); }
    let r200 = null; if (i >= 200) { let m = 0; for (let k = i - 200; k < i; k++) m += closeAt(k); r200 = closeAt(i - 1) > m / 200 ? 1 : -1; }
    out = { cur, open: cur.open, prevClose: prev.close, prevRet: i >= 2 ? prev.close / closeAt(i - 2) - 1 : 0, ret5: i >= 6 ? prev.close / closeAt(i - 6) - 1 : 0,
      meanRange: ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null, r200 };
  }
  ctxMemo.set(key, out); return out;
}
const volMemo = new Map();
function spyVol(day) {
  if (volMemo.has(day)) return volMemo.get(day);
  const s = lib.load('SPY'); const i = s.idx.get(day); let v = null;
  if (i != null && i >= 21) { const r = []; for (let k = i - 20; k < i; k++) r.push(Math.log(s.sessions.get(s.days[k]).close / s.sessions.get(s.days[k - 1]).close)); const m = r.reduce((x, y) => x + y, 0) / r.length; v = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1) * 252); }
  volMemo.set(day, v); return v;
}
const moveFromOpen = (sym, day, min) => { const c = dayCtx(sym, day); if (!c) return 0; const b = c.cur.byMin.get(min); return b ? b.c / c.open - 1 : 0; };

// ---- the events
const wins = [...lib.SCORED13, ...lib.MAP30];
const trades = lib.momentumTrades(wins, PAIRS).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at));
const seenToday = new Map();   // `${day}:${pair}` -> { n, lastLost }
const rows = [];
for (const t of trades) {
  const m = t.at - 5, side = t.side === 'up' ? 1 : -1;
  const c = dayCtx(t.pair, t.day); if (!c) continue;
  const bd = lib.band(t.pair, t.day); const lim = bd && bd.get(m); const bar = c.cur.byMin.get(m);
  if (!lim || !bar) continue;
  const hiRef = Math.max(c.open, c.prevClose), loRef = Math.min(c.open, c.prevClose);
  const sigma = side > 0 ? lim.upper / hiRef - 1 : 1 - lim.lower / loRef;
  const depth = sigma > 0 ? (side > 0 ? bar.c / lim.upper - 1 : 1 - bar.c / lim.lower) / sigma : 0;
  const upTo = c.cur.filter((b) => b.min <= m); const hi = Math.max(...upTo.map((b) => b.h)), lo = Math.min(...upTo.map((b) => b.l));
  const agree = PAIRS.filter((p) => lib.stateAt(p.proxy, t.day, m) === (side > 0 ? 'UP' : 'DOWN')).length;
  const k = `${t.day}:${t.pair}`; const st = seenToday.get(k) || { n: 0, lastLost: 0 };
  const net = t.ret - COST[symOf(t)] / 1e4;
  rows.push({ day: t.day, net, win: net > 0 ? 1 : 0, gate: (spyVol(t.day) || 0) >= 0.16 ? 1 : 0, agree,
    x: [side, t.pair === 'SPY' ? 1 : 0, t.pair === 'QQQ' ? 1 : 0, t.pair === 'SMH' ? 1 : 0, (m - 595) / 330, depth,
      side * (c.open / c.prevClose - 1) * 100, side * (bar.c / c.open - 1) * 100, c.meanRange ? ((hi - lo) / lo) / c.meanRange : 0, agree,
      (spyVol(t.day) || 0) * 10, side * c.prevRet * 100, side * c.ret5 * 100, Math.min(st.n, 3), st.lastLost,
      side * moveFromOpen('TLT', t.day, m) * 100, side * moveFromOpen('GLD', t.day, m) * 100, side * (c.r200 || 0), new Date(t.day + 'T12:00:00Z').getUTCDay() / 5] });
  seenToday.set(k, { n: st.n + 1, lastLost: net <= 0 ? 1 : 0 });
}
const NAMES = ['side', 'SPY', 'QQQ', 'SMH', 'minute', 'depth', 'gap', 'fromOpen', 'range/mean', 'agree', 'vol20', 'prevDay', '5day', 'reentries', 'lastLost', 'TLT', 'GLD', 'r200', 'weekday'];
const train = rows.filter((r) => r.day < SPLIT), test = rows.filter((r) => r.day >= SPLIT);
// standardize on the training set only
const D = NAMES.length, mu = Array(D).fill(0), sd = Array(D).fill(0);
for (const r of train) r.x.forEach((v, j) => { mu[j] += v / train.length; });
for (const r of train) r.x.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / train.length; });
for (let j = 0; j < D; j++) sd[j] = Math.sqrt(sd[j]) || 1;
const z = (x) => x.map((v, j) => (v - mu[j]) / sd[j]);
for (const r of rows) r.z = z(r.x);

// ---- L2 logistic regression, full-batch gradient descent
const w = Array(D).fill(0); let b0 = 0; const lambda = 1e-3, lr = 0.1;
const sig = (u) => 1 / (1 + Math.exp(-u));
for (let it = 0; it < 3000; it++) {
  const g = Array(D).fill(0); let gb = 0;
  for (const r of train) { const p = sig(b0 + r.z.reduce((a, v, j) => a + v * w[j], 0)); const e = p - r.win; gb += e; for (let j = 0; j < D; j++) g[j] += e * r.z[j]; }
  b0 -= lr * gb / train.length; for (let j = 0; j < D; j++) w[j] -= lr * (g[j] / train.length + lambda * w[j]);
}
for (const r of rows) r.lr = sig(b0 + r.z.reduce((a, v, j) => a + v * w[j], 0));
// ---- nearest-neighbour memory: mean net return of the K most similar training entries
for (const r of test) {
  const best = [];
  for (const q of train) {
    let d = 0; for (let j = 0; j < D; j++) { const u = r.z[j] - q.z[j]; d += u * u; }
    if (best.length < K) { best.push([d, q.net]); if (best.length === K) best.sort((a, c) => a[0] - c[0]); }
    else if (d < best[K - 1][0]) { best[K - 1] = [d, q.net]; best.sort((a, c) => a[0] - c[0]); }
  }
  r.knn = best.reduce((a, x) => a + x[1], 0) / best.length;
}
// ---- evaluation on the test entries
function auc(list, key) {
  const pos = list.filter((r) => r.win), neg = list.filter((r) => !r.win);
  const all = [...list].sort((a, c) => a[key] - c[key]); let rank = 0, sumPos = 0;
  for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j][key] === all[i][key]) j++; const avg = (i + j + 1) / 2; for (let k2 = i; k2 < j; k2++) if (all[k2].win) sumPos += avg; rank = j; i = j; }
  return (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const mean = (a) => (a.length ? a.reduce((x, r) => x + r.net, 0) / a.length : NaN);
const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(3) + '%' : '-');
function halves(key) { const s = [...test].sort((a, c) => c[key] - a[key]); const h = Math.floor(s.length / 2); return { top: mean(s.slice(0, h)), bot: mean(s.slice(h)) }; }
console.log(`entries: ${rows.length} (train before ${SPLIT}: ${train.length}, win ${pct(train.filter((r) => r.win).length / train.length)}; test: ${test.length}, win ${pct(test.filter((r) => r.win).length / test.length)}, net ${pct(mean(test))} a trade)`);
for (const [name, key] of [['logistic regression', 'lr'], [`nearest-neighbour memory (k=${K})`, 'knn']]) {
  const h = halves(key);
  console.log(`${name}: test AUC ${auc(test, key).toFixed(3)} | top half ${pct(h.top)} a trade, bottom half ${pct(h.bot)}, top minus bottom ${pct(h.top - h.bot)}`);
}
for (const [name, pick] of [['volatility gate (SPY vol >= 16%)', (r) => r.gate === 1], ['breadth >= 2', (r) => r.agree >= 2]]) {
  const a = test.filter(pick), o = test.filter((r) => !pick(r));
  console.log(`${name}: ${a.length} vs ${o.length} test entries, ${pct(mean(a))} vs ${pct(mean(o))} a trade, difference ${pct(mean(a) - mean(o))}`);
}
const trainAuc = auc(train, 'lr');
console.log(`(in-sample logistic AUC ${trainAuc.toFixed(3)}: the gap to the test AUC is what fitting found that does not generalize)`);
console.log('logistic weights (standardized): ' + NAMES.map((n, j) => `${n} ${w[j] >= 0 ? '+' : ''}${w[j].toFixed(3)}`).join(' | '));
