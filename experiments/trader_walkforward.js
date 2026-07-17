'use strict';
/**
 * trader_walkforward.js — honest walk-forward backtest of the stock autopilot.
 *
 * Drives the REAL exported signal functions (deriveDirection / rileyGate /
 * convergenceVerdict) and the REAL exit logic (protective stop, ratcheting trail,
 * momentum-death, signal-flip) bar-by-bar over historical 15m bars, with NO
 * look-ahead: at bar t only bars[0..t] are visible; entries fill at bar t+1's OPEN,
 * exits fill on the bar that triggers them. Longs-only (matches live).
 *
 * HONEST LIMITATIONS (documented, not hidden):
 *  - External anchors (news sentiment, earnings surprise, sector trend) are NOT
 *    historically reconstructable → set neutral. So this tests the PRICE/STRUCTURE
 *    signal without the news tilt.
 *  - Single timeframe: 15m for signal AND exits (live runs 15m signal + 5m momentum
 *    exit). A 15m-resolution approximation.
 *  - RSI thresholds derived from the 15m closes (live uses 1h).
 *  - Costs: 0.05%/side (0.10% round-trip) slippage+commission.
 *  - ~30 days of 15m history (Yahoo's cap) — a SHORT window; treat as directional
 *    evidence, not proof.
 *
 * Runs TWO configs — knife filter OFF vs ON — to measure the entry filter's effect.
 */

const path = require('path');
const fs = require('fs');
const APP = path.join(__dirname, '..', 'apps', 'lantern-garage');
const yahoo = require(path.join(APP, 'lib', 'market-data-yahoo'));
const { deriveDirection, rileyGate, convergenceVerdict } = require(path.join(APP, 'lib', 'signal-engine', 'scan'));
const { findSrZones } = require(path.join(APP, 'lib', 'signal-engine', 'sr-zones'));
const { detectCandlePatterns } = require(path.join(APP, 'lib', 'signal-engine', 'candles'));
const { checkMarketStructureShift } = require(path.join(APP, 'lib', 'signal-engine', 'market-structure'));
const { rsi, adaptiveRsiThresholds, macd, emaSeries, priceVsSma, volumeRatio, atr } = require(path.join(APP, 'lib', 'signal-engine', 'indicators'));
const at = require(path.join(APP, 'lib', 'auto-trader'));

const WATCH = ['SPY', 'AAPL', 'TSLA', 'NVDA', 'AMD', 'AMZN', 'INTC', 'SHOP', 'ASML', 'META', 'MSFT', 'JPM', 'GLD', 'SOXS', 'SQQQ', 'SOXL'];
const WARMUP = 60;             // bars before we start deciding (MACD 26+9, SR zones)
const COST = 0.0005;           // per side
const MIN_HOLD_BARS = 2;       // ~30 min on 15m
const STOP_PCT = 0.02, ARM_PCT = 1.5, EXIT_MIN_PWIN = 0.6;

function closesOf(bars) { return bars.map((b) => b.close); }

// One symbol, one config → array of round-trip trades. No look-ahead.
function simulateSymbol(sym, bars, useKnife) {
  const trades = [];
  let pos = null; // {entryPx, stop, peak, entryTs, entryIdx}
  for (let t = WARMUP; t < bars.length - 1; t++) {
    const slice = bars.slice(0, t + 1);
    const cur = bars[t];
    const closes = closesOf(slice);

    if (pos) {
      const held = t - pos.entryIdx;
      let exitPx = null, reason = null;
      // 1) protective stop — intrabar low breach fills at the stop.
      if (cur.low <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      // update peak on the bar high
      pos.peak = Math.max(pos.peak, cur.high);
      const peakGainPct = ((pos.peak - pos.entryPx) / pos.entryPx) * 100;
      const dropFromPeakPct = pos.peak > 0 ? ((pos.peak - cur.close) / pos.peak) * 100 : 0;
      const pnlPct = ((cur.close - pos.entryPx) / pos.entryPx) * 100;
      // 2) ratcheting trailing stop (the REAL trigger fn), armed after ARM_PCT gain.
      if (!exitPx && peakGainPct >= ARM_PCT) {
        const trig = at.trailTriggerPct(peakGainPct);
        if (dropFromPeakPct >= trig) { exitPx = cur.close; reason = 'trailing_stop'; }
      }
      // 3) momentum-death (only while in profit, after min-hold).
      if (!exitPx && held >= MIN_HOLD_BARS && pnlPct > 0 && closes.length >= 35) {
        const m = macd(closes); const e9 = emaSeries(closes, 9); const r = rsi(closes);
        if (m && m.histogram < 0 && cur.close < e9[e9.length - 1] && (r == null || r < 55)) { exitPx = cur.close; reason = 'momentum_died'; }
      }
      // 4) signal-flip exit — a strong BEARISH read after min-hold.
      if (!exitPx && held >= MIN_HOLD_BARS) {
        const sr = findSrZones(sym, cur.close, slice);
        const th = adaptiveRsiThresholds(closes);
        const rv = rsi(closes) ?? 50;
        const dir = deriveDirection(sr, rv, th);
        if (dir === 'BEARISH') {
          const struct = checkMarketStructureShift(slice, dir);
          const candle = detectCandlePatterns(slice, dir);
          const gate = rileyGate({ sr, rsiVal: rv, thresholds: th, struct, candle, direction: dir, trending: false });
          if (gate.actionable) {
            const m = macd(closes);
            const cv = convergenceVerdict({ t: sym, direction: dir, sr, struct, candle, marketStatus: { market: 'NEUTRAL' }, news_sentiment: 0, volume_ratio: volumeRatio(slice), macd_hist: m ? m.histogram : 0, ma_signal: priceVsSma(closes, 20), earnings_surprise: null, sector_trend: null });
            if (cv && cv.decision === 'ENTER' && (cv.p_win || 0) >= EXIT_MIN_PWIN) { exitPx = cur.close; reason = 'signal_exit'; }
          }
        }
      }
      if (exitPx) {
        const gross = (exitPx - pos.entryPx) / pos.entryPx;
        const retPct = gross - 2 * COST;                       // both sides
        const risk = (pos.entryPx - pos.stop) / pos.entryPx;   // fractional risk
        const R = risk > 0 ? (gross - 2 * COST) / risk : 0;
        trades.push({ sym, entryTs: pos.entryTs, exitTs: cur.timestamp, retPct, R, reason, barsHeld: held });
        pos = null;
      }
      continue;
    }

    // FLAT → look for a BULLISH ENTER (longs-only).
    const price = cur.close;
    const sr = findSrZones(sym, price, slice);
    const th = adaptiveRsiThresholds(closes);
    const rv = rsi(closes) ?? 50;
    const dir = deriveDirection(sr, rv, th);
    if (dir !== 'BULLISH') continue;
    const struct = checkMarketStructureShift(slice, dir);
    const candle = detectCandlePatterns(slice, dir);
    const gate = rileyGate({ sr, rsiVal: rv, thresholds: th, struct, candle, direction: dir, trending: false });
    if (!gate.actionable) continue;
    const m = macd(closes);
    const cv = convergenceVerdict({ t: sym, direction: dir, sr, struct, candle, marketStatus: { market: 'NEUTRAL' }, news_sentiment: 0, volume_ratio: volumeRatio(slice), macd_hist: m ? m.histogram : 0, ma_signal: priceVsSma(closes, 20), earnings_surprise: null, sector_trend: null });
    if (!cv || cv.decision !== 'ENTER') continue;
    if (useKnife && at.isFallingKnife(closes)) continue;       // the (c) filter under test
    // Fill at NEXT bar open (no look-ahead). Stop from the ATR/S-R plan, floored at STOP_PCT.
    const fill = bars[t + 1];
    const a = atr(slice) || price * 0.005;
    let stop = Math.max(price - a * 2, price * (1 - STOP_PCT));
    if (sr.support > 0 && sr.support < price && (price - sr.support) / price >= 0.005 && (price - sr.support) / price < 0.06) stop = sr.support;
    pos = { entryPx: fill.open, stop, peak: fill.open, entryTs: fill.timestamp, entryIdx: t + 1 };
  }
  return trades;
}

function metrics(trades) {
  if (!trades.length) return { n: 0 };
  const wins = trades.filter((t) => t.retPct > 0);
  const gW = wins.reduce((s, t) => s + t.retPct, 0);
  const gL = trades.filter((t) => t.retPct < 0).reduce((s, t) => s + t.retPct, 0);
  const RISK = new Set(['signal_exit', 'trailing_stop', 'stop']);
  const risk = trades.filter((t) => RISK.has(t.reason));
  const riskWins = risk.filter((t) => t.retPct > 0).length;
  // equity: risk 1% of equity per trade, ordered by exit time
  const ordered = [...trades].sort((a, b) => new Date(a.exitTs) - new Date(b.exitTs));
  let eq = 1; const curve = []; let peak = 1, mdd = 0;
  for (const t of ordered) { eq *= (1 + 0.01 * t.R); curve.push({ ts: t.exitTs, eq }); peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  // daily returns → annualized Sharpe
  const byDay = {};
  for (const p of curve) { const d = String(p.ts).slice(0, 10); byDay[d] = p.eq; }
  const days = Object.keys(byDay).sort(); const dr = [];
  for (let i = 1; i < days.length; i++) dr.push(byDay[days[i]] / byDay[days[i - 1]] - 1);
  const mean = dr.reduce((s, x) => s + x, 0) / (dr.length || 1);
  const sd = Math.sqrt(dr.reduce((s, x) => s + (x - mean) ** 2, 0) / (dr.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);
  const avgR = trades.reduce((s, t) => s + t.R, 0) / trades.length;
  const byReason = {};
  for (const t of trades) { const b = byReason[t.reason] || (byReason[t.reason] = { n: 0, wins: 0, ret: 0 }); b.n++; b.wins += t.retPct > 0 ? 1 : 0; b.ret += t.retPct; }
  return {
    n: trades.length, winRate: +(wins.length / trades.length * 100).toFixed(1),
    avgR: +avgR.toFixed(3), expectancyPct: +(trades.reduce((s, t) => s + t.retPct, 0) / trades.length * 100).toFixed(3),
    profitFactor: gL < 0 ? +(gW / Math.abs(gL)).toFixed(2) : Infinity,
    riskExitWinRate: risk.length ? +(riskWins / risk.length * 100).toFixed(1) : 0,
    finalEquity: +eq.toFixed(4), totalReturnPct: +((eq - 1) * 100).toFixed(1), maxDDpct: +(mdd * 100).toFixed(1),
    sharpe: +sharpe.toFixed(2), tradingDays: days.length, byReason, curve: curve.map((p) => ({ ts: p.ts, eq: +p.eq.toFixed(4) })),
  };
}

(async () => {
  process.stderr.write(`Fetching 15m bars for ${WATCH.length} symbols…\n`);
  const bm = await yahoo.getBarsMulti(WATCH, '15m').catch((e) => ({ bars: {}, err: e.message }));
  const bars = (bm && bm.bars) || {};
  const configs = { baseline_no_filter: false, with_knife_filter: true };
  const result = { generatedAt: new Date().toISOString(), universe: WATCH, note: 'walk-forward, no look-ahead, next-bar-open fills, longs-only, 15m, news/earnings/sector neutral, 0.10% round-trip cost', configs: {} };
  for (const [name, useKnife] of Object.entries(configs)) {
    let all = [];
    for (const sym of WATCH) {
      const b = (bars[sym] && bars[sym].bars) || [];
      if (b.length < WARMUP + 20) { process.stderr.write(`  ${sym}: only ${b.length} bars — skipped\n`); continue; }
      all = all.concat(simulateSymbol(sym, b, useKnife));
    }
    result.configs[name] = metrics(all);
    const m = result.configs[name];
    process.stderr.write(`\n[${name}] ${m.n} trades over ${m.tradingDays}d | win ${m.winRate}% | riskWin ${m.riskExitWinRate}% | avgR ${m.avgR} | PF ${m.profitFactor} | totRet ${m.totalReturnPct}% | maxDD ${m.maxDDpct}% | Sharpe ${m.sharpe}\n`);
  }
  const outPath = path.join(__dirname, '..', 'data', 'trader-walkforward.json');
  try { fs.writeFileSync(outPath, JSON.stringify(result, null, 0)); process.stderr.write(`\nWrote ${outPath}\n`); } catch (e) { process.stderr.write('write failed: ' + e.message + '\n'); }
  process.stdout.write(JSON.stringify({ baseline: result.configs.baseline_no_filter, filtered: result.configs.with_knife_filter }, (k, v) => k === 'curve' ? undefined : v, 2));
})();
