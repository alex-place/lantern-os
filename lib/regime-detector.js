"use strict";

/**
 * Regime Detector for Kalshi Prediction Markets
 *
 * Real-time market regime classification based on probability dynamics,
 * not price series. Regimes are conditions under which strategy performance
 * differs systematically.
 *
 * Regimes:
 * - Conviction_Trend: sustained directional probability movement (info flow)
 * - Reversion: oscillation around fair value, mean-reversion dominant
 * - Shock: sudden repricing due to news/events
 * - Liquidity_Fragility: spreads widen, slippage risk, shallow book
 * - Event_Countdown: time-to-resolution dominates, mechanical convergence
 */

class RegimeDetector {
  constructor() {
    // Historical buffers for trend detection (keep last N markets per ticker)
    this._history = new Map(); // ticker → { probs: [], spreads: [], times: [], timestamps: [] }
    this._historyMaxLen = 50; // keep last 50 observations per ticker
  }

  /**
   * Detect regime from a market snapshot + optional historical context
   *
   * @param {Object} market - market data { yes_bid, yes_ask, close_time, ...}
   * @param {Array<Object>} recentMarkets - optional: last N markets for same ticker
   * @returns {String} regime name
   */
  detect(market, recentMarkets = null) {
    if (!market) return "Unknown";

    const nowMs = Date.now();
    const closeMsUTC = new Date(market.close_time).getTime();
    const minsToClose = Math.max(0, (closeMsUTC - nowMs) / 60_000);

    // Probability at mid
    const mid = (market.yes_bid + market.yes_ask) / 2;
    const prob = mid / 100; // convert to 0-1

    // Spread (basis points)
    const spread = market.yes_ask - market.yes_bid;
    const spreadBps = (spread / mid) * 10_000;

    // Early signal: Event Countdown (last 30 min dominates everything)
    if (minsToClose < 30) {
      return "Event_Countdown";
    }

    // If no history, classify based on static properties
    if (!recentMarkets || recentMarkets.length < 3) {
      return this._classifyStatic(prob, spread, spreadBps, minsToClose);
    }

    // Extract probability trajectory from recent markets
    const probs = recentMarkets.map(m => (m.yes_bid + m.yes_ask) / 2 / 100);
    const spreads = recentMarkets.map(m => m.yes_ask - m.yes_bid);
    const recentSpreadBps = spreads.map(s => (s / (spreads[spreads.length - 1] || 1)) * 10_000);

    // Analyze trend
    const trend = this._analyzeTrend(probs);
    const spreadTrend = this._analyzeTrend(recentSpreadBps);
    const volatility = this._calculateVolatility(probs);

    // Classification logic (priority order)

    // 1. Shock: large sudden jump + high volatility
    if (volatility > 0.15 && Math.abs(probs[probs.length - 1] - probs[0]) > 0.15) {
      return "Shock";
    }

    // 2. Liquidity_Fragility: spreads widening trend + elevated spread
    if (spreadTrend > 0.1 && spreadBps > 50) {
      return "Liquidity_Fragility";
    }

    // 3. Conviction_Trend: sustained directional movement (not oscillating)
    if (Math.abs(trend) > 0.05 && volatility < 0.08) {
      return "Conviction_Trend";
    }

    // 4. Reversion: oscillating around mean, low net drift
    if (Math.abs(trend) < 0.02 && volatility > 0.04 && volatility < 0.12) {
      return "Reversion";
    }

    // Default: static classification
    return this._classifyStatic(prob, spread, spreadBps, minsToClose);
  }

  /**
   * Static classification (no history available)
   * @private
   */
  _classifyStatic(prob, spread, spreadBps, minsToClose) {
    // If spreads are very wide, it's fragility
    if (spreadBps > 80) {
      return "Liquidity_Fragility";
    }

    // If prob is extreme (near 0 or 1), it's either conviction or shock
    if (prob < 0.1 || prob > 0.9) {
      return "Conviction_Trend";
    }

    // Default: reversion (markets tend to be mean-reverting)
    return "Reversion";
  }

  /**
   * Calculate simple linear trend (slope of last N points)
   * @private
   */
  _analyzeTrend(values) {
    if (!values || values.length < 2) return 0;

    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = values.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (x[i] - meanX) * (values[i] - meanY);
      denominator += (x[i] - meanX) ** 2;
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Calculate volatility (std dev of returns)
   * @private
   */
  _calculateVolatility(values) {
    if (!values || values.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < values.length; i++) {
      returns.push(Math.log(values[i] / values[i - 1]));
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /**
   * Update detector with new market observation (for streaming context)
   * @param {String} ticker
   * @param {Object} market
   */
  observe(ticker, market) {
    if (!this._history.has(ticker)) {
      this._history.set(ticker, { probs: [], spreads: [], times: [], timestamps: [] });
    }

    const buf = this._history.get(ticker);
    const mid = (market.yes_bid + market.yes_ask) / 2;
    const prob = mid / 100;
    const spread = market.yes_ask - market.yes_bid;

    buf.probs.push(prob);
    buf.spreads.push(spread);
    buf.times.push(new Date(market.close_time).getTime());
    buf.timestamps.push(Date.now());

    // Keep last N
    if (buf.probs.length > this._historyMaxLen) {
      buf.probs.shift();
      buf.spreads.shift();
      buf.times.shift();
      buf.timestamps.shift();
    }
  }

  /**
   * Get regime with full context from accumulated history
   * @param {String} ticker
   * @param {Object} market
   * @returns {String} regime
   */
  detectWithHistory(ticker, market) {
    const history = this._history.get(ticker);
    return this.detect(market, history?.probs?.length > 0 ? [{ yes_bid: history.probs[history.probs.length - 1] * 100, yes_ask: market.yes_ask }] : null);
  }
}

module.exports = RegimeDetector;
