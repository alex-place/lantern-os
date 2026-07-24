/**
 * signal-engine/indicators.js — RSI + adaptive RSI thresholds.
 *
 * Ported from src/trading_agents/agents.py:
 *   - calc_rsi_series (inside get_adaptive_rsi_thresholds)
 *   - get_adaptive_rsi_thresholds (percentile bands over a 90d hourly RSI series)
 *
 * Pure functions over close-price arrays; no I/O. The caller supplies the closes
 * (the Node engine pulls hourly bars from lib/market-data-yahoo.js).
 */
"use strict";

// Simple (SMA) RSI, matching the Python engine exactly: a sliding window of
// `period+1` closes, average gain/loss over the `period` deltas, then
// RSI = 100 - 100/(1+rs). When average loss is 0, RSI = 100. Values rounded
// to 1 decimal (as Python did) so the percentile bands line up.
function rsiSeries(closes, period = 14) {
  const out = [];
  if (!Array.isArray(closes)) return out;
  for (let i = period; i < closes.length; i++) {
    const w = closes.slice(i - period, i + 1);
    let gains = 0;
    let losses = 0;
    for (let j = 1; j < w.length; j++) {
      const d = w[j] - w[j - 1];
      if (d > 0) gains += d;
      else losses += -d;
    }
    const ag = gains / period;
    const al = losses / period;
    if (al === 0) out.push(100.0);
    else out.push(Math.round((100 - 100 / (1 + ag / al)) * 10) / 10);
  }
  return out;
}

// Latest RSI value (or null if not enough data).
function rsi(closes, period = 14) {
  const s = rsiSeries(closes, period);
  return s.length ? s[s.length - 1] : null;
}

const RSI_FALLBACK = {
  oversold: 35,
  overbought: 65,
  p10: 30,
  p25: 40,
  p75: 60,
  p90: 70,
  median: 50,
  source: "fallback",
};

// Stock-specific oversold/overbought bands from a history of closes.
// oversold = 15th percentile of the RSI series, overbought = 85th, etc.
// (Python used ~90 days of hourly bars; here the caller supplies the closes.)
function adaptiveRsiThresholds(closes) {
  if (!Array.isArray(closes) || closes.length < 50) return { ...RSI_FALLBACK };
  const series = rsiSeries(closes);
  if (series.length < 20) return { ...RSI_FALLBACK };
  const sorted = series.slice().sort((a, b) => a - b);
  const n = sorted.length;
  // Python: idx = int(p/100 * n); return sorted[min(idx, n-1)]
  const pct = (p) =>
    Math.round(sorted[Math.min(Math.floor((p / 100) * n), n - 1)] * 10) / 10;
  return {
    oversold: pct(15),
    overbought: pct(85),
    p10: pct(10),
    p25: pct(25),
    p75: pct(75),
    p90: pct(90),
    median: pct(50),
    source: `history (${n} RSI values)`,
  };
}

// ── EMA / MACD / volume (Tier-1 confirmation signals) ───────────────────────
/** Exponential moving average series over `values` (period). [] if too short. */
function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed = SMA
  const out = [ema];
  for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); out.push(ema); }
  return out;
}

/** MACD(fast,slow,signal) over closes → { macd, signal, histogram } (latest values),
 *  or null when there aren't enough bars. Histogram sign/curl is the confirmation. */
function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signalP) return null;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  // align the two EMA series to the same (later) start
  const off = ef.length - es.length;
  const macdLine = es.map((v, i) => ef[i + off] - v);
  const sig = emaSeries(macdLine, signalP);
  if (!sig.length) return null;
  const m = macdLine[macdLine.length - 1];
  const s = sig[sig.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

/** Price vs its SMA(period): +1 above, -1 below, 0 flat/insufficient. */
function priceVsSma(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return 0;
  const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const last = closes[closes.length - 1];
  if (last > sma * 1.001) return 1;
  if (last < sma * 0.999) return -1;
  return 0;
}

/** Recent volume vs its own average → ratio (1 = normal, >1 = spike). Uses the
 *  last bar's volume against the trailing `lookback` average. 1 when unavailable. */
function volumeRatio(bars, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < 3) return 1;
  const vols = bars.map((b) => Number(b.volume) || 0).filter((v) => v > 0);
  if (vols.length < 3) return 1;
  const recent = vols[vols.length - 1];
  const window = vols.slice(-Math.min(lookback + 1, vols.length), -1);
  const avg = window.reduce((a, b) => a + b, 0) / (window.length || 1);
  return avg > 0 ? recent / avg : 1;
}

/** Average True Range over OHLC bars (period). Used to size stops/targets and
 *  estimate a holding horizon. 0 when unavailable. */
function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].high), l = Number(bars[i].low), pc = Number(bars[i - 1].close);
    if (![h, l, pc].every(Number.isFinite)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!trs.length) return 0;
  const w = trs.slice(-period);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

module.exports = { rsi, rsiSeries, adaptiveRsiThresholds, RSI_FALLBACK, emaSeries, macd, priceVsSma, volumeRatio, atr };

if (require.main === module) {
  // Rising, oscillating series → RSI should sit above 50; bands straddle it.
  const closes = Array.from(
    { length: 140 },
    (_, i) => 100 + 8 * Math.sin(i / 6) + i * 0.15,
  );
  console.log("rsi(last):", rsi(closes));
  console.log("adaptiveRsiThresholds:", adaptiveRsiThresholds(closes));
  console.log("short-data fallback:", adaptiveRsiThresholds([1, 2, 3]));
}
