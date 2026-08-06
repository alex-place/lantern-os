'use strict';
/**
 * zone_ladder_15m.js — 15m verification of the zone-ladder exit (#3165).
 *
 * The daily-bar OOS validation (fit 2000-2014 / holdout 2015-2026) passed the
 * ladder on SPY+QQQ. This is the production-scale check: the REAL signal
 * functions on REAL 15m bars, comparing the LIVE exit ladder (ratcheting trail
 * + momentum-death + signal-flip, verbatim from trader_walkforward.js) against
 * the operator's ZONE ladder:
 *   - sell at R1 (first resistance zone above entry) unless a bar CLOSES
 *     through it (momentum) — then R2 becomes the target and the floor
 *     ratchets to R1 (give-backs exit there);
 *   - protective stop always live underneath.
 *
 * HONEST LIMITATION: Yahoo caps 15m history at ~30 trading days. Treat as a
 * directional sanity check on ~weeks of data, not proof. The 26-year evidence
 * lives in spy_engine_backtest.js / #3165.
 *
 * Usage: node experiments/zone_ladder_15m.js [--symbols SPY,QQQ]
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'apps', 'lantern-garage');
const yahoo = require(path.join(APP, 'lib', 'market-data-yahoo'));
const { deriveDirection, rileyGate, convergenceVerdict } = require(path.join(APP, 'lib', 'signal-engine', 'scan'));
const { findSrZones } = require(path.join(APP, 'lib', 'signal-engine', 'sr-zones'));
const { detectCandlePatterns } = require(path.join(APP, 'lib', 'signal-engine', 'candles'));
const { checkMarketStructureShift } = require(path.join(APP, 'lib', 'signal-engine', 'market-structure'));
const { rsi, adaptiveRsiThresholds, macd, emaSeries, priceVsSma, volumeRatio, atr } = require(path.join(APP, 'lib', 'signal-engine', 'indicators'));
const at = require(path.join(APP, 'lib', 'auto-trader'));

const WARMUP = 60, COST = 0.0005, MIN_HOLD_BARS = 2, STOP_FLOOR = 0.008, ARM_PCT = 1.5, EXIT_MIN_PWIN = 0.6;
const STOP_MULT = 2.2; // trader_walkforward's shipped lever

function closesOf(bars) { return bars.map((b) => b.close); }

function simulate(sym, bars, exitMode, entryAtrMax, entryMode) {
  const trades = [];
  let pos = null;
  for (let t = WARMUP; t < bars.length - 1; t++) {
    const slice = bars.slice(0, t + 1);
    const cur = bars[t];
    const closes = closesOf(slice);

    if (pos) {
      const held = t - pos.entryIdx;
      let exitPx = null, reason = null;
      if (cur.low <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      pos.peak = Math.max(pos.peak, cur.high);

      if (!exitPx && exitMode === 'zone' && pos.r1 != null) {
        // Operator's ladder (#3165): close-through R1 upgrades target to R2 and
        // ratchets the floor to R1; a mere touch without close-through sells at R1.
        if (!pos.brokeR1) {
          if (cur.close > (pos.r1top || pos.r1)) pos.brokeR1 = true;
          else if (cur.high >= pos.r1) { exitPx = pos.r1; reason = 'zone_r1'; }
        } else if (pos.r2 != null && cur.high >= pos.r2) { exitPx = pos.r2; reason = 'zone_r2'; }
        else if (pos.brokeR1 && cur.low <= pos.r1) { exitPx = pos.r1; reason = 'zone_r1_floor'; }
      }

      if (exitMode === 'live') {
        const peakGainPct = ((pos.peak - pos.entryPx) / pos.entryPx) * 100;
        const dropFromPeakPct = pos.peak > 0 ? ((pos.peak - cur.close) / pos.peak) * 100 : 0;
        const pnlPct = ((cur.close - pos.entryPx) / pos.entryPx) * 100;
        if (!exitPx && peakGainPct >= ARM_PCT) {
          const trig = at.trailTriggerPct(peakGainPct);
          if (dropFromPeakPct >= trig) { exitPx = cur.close; reason = 'trailing_stop'; }
        }
        if (!exitPx && held >= MIN_HOLD_BARS && pnlPct > 0 && closes.length >= 35) {
          const m = macd(closes); const e9 = emaSeries(closes, 9); const r = rsi(closes);
          if (m && m.histogram < 0 && cur.close < e9[e9.length - 1] && (r == null || r < 55)) { exitPx = cur.close; reason = 'momentum_died'; }
        }
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
      }

      if (exitPx) {
        const gross = (exitPx - pos.entryPx) / pos.entryPx;
        const risk = (pos.entryPx - pos.stop) / pos.entryPx;
        const R = risk > 0 ? (gross - 2 * COST) / risk : 0;
        trades.push({ sym, retPct: gross - 2 * COST, R, reason, barsHeld: held });
        pos = null;
      }
      continue;
    }

    // FLAT -> BULLISH ENTER (longs-only) — identical entry logic in both modes.
    const price = cur.close;
    const sr = findSrZones(sym, price, slice);
    const th = adaptiveRsiThresholds(closes);
    const rv = rsi(closes) ?? 50;
    // MEAN-REVERSION ENTRY (entryMode='meanrev', 2026-08-06). signal_audit.js
    // found every momentum/confirmation component INVERTED on daily bars and
    // RSI-oversold the only informative one (t=+5.4). On daily bars replacing the
    // stack with it took OOS avg R 0.266 -> 0.581. This is the 15m check of that
    // claim on the timeframe the trader actually runs.
    const _mr = entryMode === 'meanrev';
    const dir = _mr ? (rv <= th.oversold ? 'BULLISH' : 'NEUTRAL') : deriveDirection(sr, rv, th);
    if (dir !== 'BULLISH') continue;
    const struct = checkMarketStructureShift(slice, dir);
    const candle = detectCandlePatterns(slice, dir);
    const gate = rileyGate({ sr, rsiVal: rv, thresholds: th, struct, candle, direction: dir, trending: false });
    if (!gate.actionable && !_mr) continue;
    const m = macd(closes);
    const cv = convergenceVerdict({ t: sym, direction: dir, sr, struct, candle, marketStatus: { market: 'NEUTRAL' }, news_sentiment: 0, volume_ratio: volumeRatio(slice), macd_hist: m ? m.histogram : 0, ma_signal: priceVsSma(closes, 20), earnings_surprise: null, sector_trend: null });
    if ((!cv || cv.decision !== 'ENTER') && !_mr) continue;
    if (at.isFallingKnife(closes)) continue;
    const fill = bars[t + 1];
    const a = atr(slice) || price * 0.005;
    // SUPPORT-ZONE ENTRY GATE (operator design 2026-08-04): the long is only taken
    // AT the support zone — "the bottom zone is obviously where we want to enter" —
    // not mid-chop on a generic BULLISH read. Gate: price within entryAtrMax ATRs
    // above the nearest support zone's top. No support below -> no trade.
    // 'trend' gate: only long when price sits above its 15m SMA-200 (~2 weeks) —
    // higher-timeframe context the 15m scan lacks. Chop diagnosis: support zones
    // keep breaking; distance-to-support is NOT the problem (gate above was ~no-op).
    if (entryAtrMax === 'trend') {
      if (closes.length < 200) continue;
      const s200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
      if (price <= s200) continue;
    } else if (entryAtrMax != null) {
      const sup = ((sr && sr.zones) || []).filter((z) => /SUPPORT/i.test(z.type || '') && (z.top || z.level) <= price * 1.001)
        .sort((x, y) => (y.top || y.level) - (x.top || x.level))[0];
      if (!sup) continue;
      const distAtr = (price - (sup.top || sup.level)) / a;
      if (distAtr > entryAtrMax) continue;
    }
    const stop = Math.max(price - a * STOP_MULT, price * (1 - STOP_FLOOR));
    const res = ((sr && sr.zones) || []).filter((z) => /RESIST/i.test(z.type || '') && z.level > fill.open * 1.001)
      .sort((x, y) => x.level - y.level);
    pos = {
      entryPx: fill.open, entryIdx: t + 1, stop, peak: fill.open,
      r1: res[0] ? res[0].level : null, r1top: res[0] ? res[0].top : null,
      r2: res[1] ? res[1].level : null, brokeR1: false,
    };
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0 };
  const wins = trades.filter((x) => x.R > 0);
  const gw = trades.filter((x) => x.R > 0).reduce((a, x) => a + x.R, 0);
  const gl = Math.abs(trades.filter((x) => x.R <= 0).reduce((a, x) => a + x.R, 0));
  const tot = trades.reduce((a, x) => a + x.R, 0);
  const reasons = {};
  for (const x of trades) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  return {
    n: trades.length, win_pct: +(wins.length / trades.length * 100).toFixed(1),
    pf: gl > 0 ? +(gw / gl).toFixed(2) : Infinity, total_R: +tot.toFixed(1),
    avg_R: +(tot / trades.length).toFixed(3), reasons,
  };
}

(async () => {
  const args = process.argv.slice(2);
  const syms = (args.indexOf('--symbols') >= 0 ? args[args.indexOf('--symbols') + 1] : 'SPY,QQQ').split(',');
  for (const sym of syms) {
    const data = await yahoo.getBars(sym.trim(), '15m');
    const bars = (data && data.bars) || [];
    if (bars.length < WARMUP + 10) { console.log(`${sym}: only ${bars.length} 15m bars — skipped`); continue; }
    console.log(`\n=== ${sym} — ${bars.length} x 15m bars (${bars[0].timestamp.slice(0, 10)} -> ${bars[bars.length - 1].timestamp.slice(0, 10)})`);
    for (const [label, mode, gate, entryMode] of [
      ['live        ', 'live', null],
      ['zone        ', 'zone', null],
      ['zone+sup1.0 ', 'zone', 1.0],
      ['zone+sup0.5 ', 'zone', 0.5],
      ['zone+sup0.25', 'zone', 0.25],
      ['zone+trend  ', 'zone', 'trend'],
      ['live+trend  ', 'live', 'trend'],
      ['MR zone     ', 'zone', null, 'meanrev'],
      ['MR zone+sup ', 'zone', 0.5, 'meanrev'],
      ['MR live     ', 'live', null, 'meanrev'],
    ].map((r) => [r[0], r[1], r[2], r[3]])) {
      const s = summarize(simulate(sym.trim(), bars, mode, gate, entryMode));
      console.log(`  ${label} n=${s.n ?? 0} win=${s.win_pct ?? '-'}% PF=${s.pf ?? '-'} totR=${s.total_R ?? '-'} avgR=${s.avg_R ?? '-'} exits=${JSON.stringify(s.reasons || {})}`);
    }
  }
})();
