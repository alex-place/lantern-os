#!/usr/bin/env node
'use strict';
/**
 * trader-backtest.js — walk-forward backtest of the Σ₀ signal engine's TA core.
 *
 * Replays the engine bar-by-bar over historical 15m bars: at each bar it runs the
 * SAME zone/structure/RSI/candle gate + EV verdict (volume + momentum included)
 * using ONLY data up to that bar (no lookahead), and when the verdict is ENTER it
 * simulates the trade forward — exit at the protective stop, target-1, or a time
 * stop — and records the R-multiple. Then reports win-rate, expectancy, profit
 * factor, total return.
 *
 * HONEST SCOPE: news / earnings / sector are point-in-time (current) inputs — we
 * have no historical feed for them — so they are held NEUTRAL here. This measures
 * the TA + volume + momentum core, NOT the full live engine. It's a floor: if the
 * core has no edge, the extras won't save it; if it does, the extras add to it.
 *
 * Usage:  node scripts/trader-backtest.js [SYM1 SYM2 ...]   (defaults to a basket)
 */
const path = require('path');
const LIB = path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'signal-engine');
const yahoo = require(path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'market-data-yahoo'));
const { rsi, adaptiveRsiThresholds, macd, priceVsSma, volumeRatio, atr } = require(path.join(LIB, 'indicators'));
const { findSrZones } = require(path.join(LIB, 'sr-zones'));
const { detectCandlePatterns } = require(path.join(LIB, 'candles'));
const { checkMarketStructureShift } = require(path.join(LIB, 'market-structure'));
const { deriveDirection, rileyGate, convergenceVerdict } = require(path.join(LIB, 'scan'));

const WARMUP = 40;            // bars needed before the first decision
const HOLD_BARS = 26 * 3;     // time stop ≈ 3 trading days of 15m bars
const COST_R = 0.03;          // ~round-trip cost as a fraction of risk (slippage+comm)

function simulateTrade(bars, i, dir, entry, stopPx, targetPx) {
  const risk = Math.abs(entry - stopPx) || entry * 0.015;
  const up = dir === 'BULLISH';
  for (let j = i + 1; j < Math.min(i + HOLD_BARS, bars.length); j++) {
    const b = bars[j];
    if (up) {
      if (b.low <= stopPx) return -1;                    // stopped
      if (b.high >= targetPx) return (targetPx - entry) / risk; // target hit
    } else {
      if (b.high >= stopPx) return -1;
      if (b.low <= targetPx) return (entry - targetPx) / risk;
    }
  }
  // time stop → mark to the last close
  const last = bars[Math.min(i + HOLD_BARS, bars.length - 1)].close;
  return (up ? last - entry : entry - last) / risk;
}

async function backtestTicker(sym) {
  const res = await yahoo.getBars(sym, '15m').catch(() => null);
  const bars = (res && res.bars) || [];
  if (bars.length < WARMUP + 20) return { sym, trades: [], note: 'insufficient bars' };
  const trades = [];
  let openUntil = -1; // don't open a new trade while one is live (one position/ticker)
  for (let i = WARMUP; i < bars.length - 2; i++) {
    if (i < openUntil) continue;
    const slice = bars.slice(0, i + 1);
    const price = slice[i].close;
    const closes = slice.map((b) => b.close);
    const sr = findSrZones(sym, price, slice);
    const thresholds = adaptiveRsiThresholds(closes);
    const rsiVal = rsi(closes) ?? 50;
    const direction = deriveDirection(sr, rsiVal, thresholds);
    const struct = checkMarketStructureShift(slice, direction);
    const candle = detectCandlePatterns(slice, direction);
    const gate = rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending: false });
    if (!gate.actionable) continue;
    const volume_ratio = volumeRatio(slice);
    const m = macd(closes);
    const verdict = convergenceVerdict({
      t: sym, direction, sr, struct, candle, marketStatus: {},
      volume_ratio, macd_hist: m ? m.histogram : 0, ma_signal: priceVsSma(closes, 20),
    });
    if (!verdict || verdict.decision !== 'ENTER') continue;
    // plan (mirror scan.js): ATR risk, target = target_r × risk
    const a = atr(slice);
    const risk = Math.max((a || 0) * 2, price * 0.015);
    const up = direction === 'BULLISH';
    const stopPx = up ? price - risk : price + risk;
    const tr = verdict.target_r || 2;
    const targetPx = up ? price + tr * risk : price - tr * risk;
    const r = simulateTrade(bars, i, direction, price, stopPx, targetPx) - COST_R;
    trades.push({ i, dir: direction, r });
    // block re-entry until this trade would have closed
    openUntil = i + HOLD_BARS;
  }
  return { sym, trades };
}

function stats(allTrades) {
  const n = allTrades.length;
  if (!n) return { n: 0 };
  const wins = allTrades.filter((t) => t.r > 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = allTrades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  const totalR = allTrades.reduce((s, t) => s + t.r, 0);
  return {
    n,
    win_rate: +(wins.length / n * 100).toFixed(1),
    avg_R: +(totalR / n).toFixed(3),
    total_R: +totalR.toFixed(1),
    profit_factor: grossLoss ? +(grossWin / Math.abs(grossLoss)).toFixed(2) : Infinity,
    expectancy_note: totalR > 0 ? 'POSITIVE expectancy' : 'NEGATIVE/flat — no edge',
  };
}

(async () => {
  const syms = process.argv.slice(2).length ? process.argv.slice(2)
    : ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'JPM', 'INTC'];
  console.log(`Σ₀ TA-core backtest — ${syms.length} tickers, 15m bars, ~1mo history\n`);
  const all = [];
  for (const s of syms) {
    const r = await backtestTicker(s);
    const st = stats(r.trades);
    all.push(...r.trades);
    console.log(`  ${s.padEnd(6)} trades=${String(st.n || 0).padStart(3)} ${st.n ? `win%=${st.win_rate} avgR=${st.avg_R} totalR=${st.total_R} PF=${st.profit_factor}` : (r.note || '')}`);
  }
  const overall = stats(all);
  console.log('\n── OVERALL ──────────────────────────────');
  console.log(JSON.stringify(overall, null, 2));
  console.log(`\nEach R = one unit of risk (the entry→stop distance). Total R × your`);
  console.log(`per-trade risk $ ≈ P&L. ${overall.n ? overall.expectancy_note : 'no trades'}.`);
})().catch((e) => { console.error('backtest error:', e.message); process.exit(1); });
