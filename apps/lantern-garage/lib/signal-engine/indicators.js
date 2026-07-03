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

module.exports = { rsi, rsiSeries, adaptiveRsiThresholds, RSI_FALLBACK };

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
