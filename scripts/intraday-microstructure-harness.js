#!/usr/bin/env node
'use strict';
/**
 * intraday-microstructure-harness.js — the "industrial √N" probe.
 *
 * WHY: the daily leaderboard harness showed we can only find a handful of daily
 * sleeves, and their edge caps COMBO Sharpe near ~1.1. Elite Sharpe (4–10) comes
 * from the Fundamental Law of Active Management — Sharpe ≈ edge × √(independent
 * bets) — run at HIGH FREQUENCY across MANY instruments. This harness tests that
 * path with the one strategy that is genuinely a many-small-edges microstructure
 * effect: intraday CROSS-SECTIONAL SHORT-TERM REVERSAL (Lehmann 1990;
 * Lo–MacKinlay). Each 15m bar, rank the universe by last-bar return, go long the
 * relative losers / short the relative winners (dollar-neutral, market-neutral),
 * hold one bar. Breadth = names × bars ≈ thousands of tiny bets.
 *
 * THE HONEST POINT — costs. Gross, this reversal effect is real and its Sharpe
 * scales ~√N with breadth. NET, it rebalances the whole book every bar, so it is
 * murdered by transaction costs unless you are fast/cheap enough to trade inside
 * the spread. This harness SWEEPS the per-turnover cost and reports the break-even
 * cost — i.e. exactly how much of an execution edge you'd need to make it live.
 * That break-even is the real dividing line between "retail idea" and "HFT desk."
 *
 * SCOPE: Yahoo 15m bars reach ~1 month back (their history limit), survivorship-
 * biased universe, mid-bar close prices (no real fills/spread). This is a
 * DIRECTIONAL PROBE of the √N-at-frequency thesis, not a live P&L claim.
 *
 * Usage:  node scripts/intraday-microstructure-harness.js
 */

const path = require('path');
const yahoo = require(path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'market-data-yahoo'));

const UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'ADBE', 'CRM', 'ORCL', 'CSCO',
  'INTC', 'AMD', 'QCOM', 'TXN', 'AVGO', 'IBM', 'JPM', 'BAC', 'WFC', 'GS',
  'MS', 'C', 'AXP', 'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'TMO', 'WMT',
  'HD', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'COST', 'DIS', 'XOM', 'CVX',
  'CAT', 'BA', 'GE', 'HON',
];
const TF = '15m';
const BARS_PER_YEAR = 26 * 252; // ~15m bars in a US trading year (6.5h → 26 bars)
const COST_SWEEP_BPS = [0, 0.5, 1, 2, 5, 10]; // per unit of one-way turnover

function sd(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function sharpe(rets) {
  if (rets.length < 2) return 0;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const s = sd(rets);
  return s > 0 ? (m / s) * Math.sqrt(BARS_PER_YEAR) : 0;
}

// Run the cross-sectional reversal book over an aligned close matrix.
// closes: Array<Array<number>>  [timeIndex][nameIndex]  (already intersected).
// Returns { gross:[perBarPnl], turnover:[perBar], bars, names }.
function reversalBook(closes, nameIdx) {
  const T = closes.length;
  const N = nameIdx.length;
  const gross = [];
  const turnover = [];
  let prevW = new Array(N).fill(0);
  for (let t = 1; t < T - 1; t++) {
    // last-bar return per name
    const r = nameIdx.map((j) => closes[t][j] / closes[t - 1][j] - 1);
    const mean = r.reduce((s, x) => s + x, 0) / N;
    // reversal signal = short winners / long losers, cross-sectionally demeaned
    const raw = r.map((x) => -(x - mean));
    const grossExp = raw.reduce((s, x) => s + Math.abs(x), 0) || 1e-9;
    const w = raw.map((x) => x / grossExp); // gross exposure 1, ~dollar-neutral
    // next-bar return realized on this book
    const rNext = nameIdx.map((j) => closes[t + 1][j] / closes[t][j] - 1);
    let pnl = 0;
    for (let k = 0; k < N; k++) pnl += w[k] * rNext[k];
    let tover = 0;
    for (let k = 0; k < N; k++) tover += Math.abs(w[k] - prevW[k]);
    gross.push(pnl);
    turnover.push(tover);
    prevW = w;
  }
  return { gross, turnover, bars: gross.length, names: N };
}

function netSharpe(book, costBps) {
  const c = costBps / 10000;
  const net = book.gross.map((g, i) => g - c * book.turnover[i]);
  return sharpe(net);
}

(async () => {
  process.stdout.write(`Fetching ${TF} bars (~1mo) for ${UNIVERSE.length} names...\n`);
  const res = await yahoo.getBarsMulti(UNIVERSE, TF);
  const perSym = {};
  for (const sym of UNIVERSE) {
    const bars = (res.bars[sym] && res.bars[sym].bars) || [];
    if (bars.length > 50) perSym[sym] = new Map(bars.map((b) => [b.timestamp, b.close]));
  }
  const names = Object.keys(perSym);
  if (names.length < 8) { console.error('too few names with data'); process.exit(1); }

  // aligned timestamp axis = timestamps present for ALL surviving names
  const first = perSym[names[0]];
  const stamps = [...first.keys()].filter((ts) => names.every((n) => perSym[n].has(ts))).sort();
  if (stamps.length < 100) { console.error(`too few aligned bars (${stamps.length})`); process.exit(1); }
  const closes = stamps.map((ts) => names.map((n) => perSym[n].get(ts)));

  console.log(`\nIntraday cross-sectional reversal — ${names.length} names × ${stamps.length} bars (${TF})`);
  console.log(`window: ${stamps[0].slice(0, 16)} → ${stamps[stamps.length - 1].slice(0, 16)}\n`);

  const idxAll = names.map((_, j) => j);
  const book = reversalBook(closes, idxAll);

  // ── √N breadth scaling (GROSS) ──
  console.log('  √N BREADTH TEST (gross, before costs) — Sharpe should rise ≈ with √N:\n');
  console.log('  ' + 'names (N)'.padEnd(12) + '√N'.padStart(7) + 'gross Sharpe'.padStart(15) + '   Sharpe/√N');
  for (const N of [4, 8, 16, 32, names.length].filter((n, i, a) => n <= names.length && a.indexOf(n) === i)) {
    const b = reversalBook(closes, idxAll.slice(0, N));
    const s = sharpe(b.gross);
    console.log('  ' + String(N).padEnd(12) + Math.sqrt(N).toFixed(2).padStart(7) + s.toFixed(2).padStart(15) + '   ' + (s / Math.sqrt(N)).toFixed(3));
  }

  // ── cost sweep (the honest part) ──
  console.log(`\n  COST SWEEP — full universe (N=${names.length}); avg turnover/bar = ${(book.turnover.reduce((s, x) => s + x, 0) / book.turnover.length).toFixed(2)}:\n`);
  console.log('  ' + 'cost (bps/turnover)'.padEnd(22) + 'net ann. Sharpe'.padStart(16) + '   live?');
  let breakeven = null;
  for (const c of COST_SWEEP_BPS) {
    const s = netSharpe(book, c);
    if (breakeven === null && s <= 0) breakeven = c;
    console.log('  ' + String(c).padEnd(22) + s.toFixed(2).padStart(16) + '   ' + (s > 0.5 ? 'yes' : s > 0 ? 'marginal' : 'DEAD'));
  }

  const grossS = sharpe(book.gross);
  const avgTover = book.turnover.reduce((s, x) => s + x, 0) / book.turnover.length;
  // break-even cost: gross mean pnl / mean turnover, in bps
  const meanPnl = book.gross.reduce((s, x) => s + x, 0) / book.gross.length;
  const beBps = avgTover > 0 ? (meanPnl / avgTover) * 10000 : 0;

  console.log(`\n  ── VERDICT ─────────────────────────────────────────────`);
  console.log(`  Gross Sharpe (N=${names.length}, ${TF}, ~1mo): ${grossS.toFixed(2)} — the √N-at-frequency edge is ${grossS > 1 ? 'REAL' : 'weak'} before costs.`);
  console.log(`  Break-even cost ≈ ${beBps.toFixed(2)} bps per unit turnover (≈ ${(beBps).toFixed(1)} bps round-trip on the book).`);
  console.log(`  → To run this LIVE you must trade for LESS than ~${beBps.toFixed(1)} bps all-in. Retail pays 1–5 bps+ spread`);
  console.log(`    per side on these names → typically ABOVE break-even → DEAD net. HFT co-location/rebates get BELOW it → alive.`);
  console.log(`  This is the exact wall between the daily-sleeve world (Sharpe ~1.1) and the HFT world (Sharpe 4–10):`);
  console.log(`  the edge and the √N breadth are real; capturing them net-of-cost is an EXECUTION/INFRASTRUCTURE problem, not a signal one.\n`);
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
