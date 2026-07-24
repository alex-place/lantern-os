/**
 * trader-price-feed.js — Trading Phase 5 (issue #326)
 *
 * Provides OHLCV tick data for the watchlist.
 * Priority: live Alpaca REST → simulated fallback (clearly labeled).
 *
 * Tick format: { symbol, price, open, high, low, close, volume, ts, source }
 * source: "live" | "simulated"
 *
 * Usage:
 *   const feed = new TradingPriceFeed(traderAgent);
 *   const result = await feed.getTicks('AAPL', '1D');
 *   // result: { symbol, range, ticks: [...], source, generated_at }
 */

'use strict';

const SEED_PRICES = {
  SPY:  545.0,  QQQ:  470.0,  AAPL: 191.0,
  TSLA: 248.0,  NVDA: 910.0,  MSFT: 432.0,
  AMZN: 195.0,  META: 530.0,  GOOGL: 178.0,
  AMD:  165.0,  INTC:  30.0,  NFLX: 675.0,
};

const RANGE_BARS = { '1D': 78, '5D': 100, '1M': 120 }; // bars to generate per range
const RANGE_INTERVAL_MS = { '1D': 5 * 60 * 1000, '5D': 30 * 60 * 1000, '1M': 4 * 60 * 60 * 1000 };

/**
 * Deterministic seeded PRNG (mulberry32) for reproducible simulated prices.
 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function strSeed(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Generate simulated OHLCV bars for a symbol + range.
 * Uses a seeded random walk anchored to a known base price + daily drift.
 */
function simulateBars(symbol, range) {
  const bars   = RANGE_BARS[range]   || 78;
  const intMs  = RANGE_INTERVAL_MS[range] || 5 * 60 * 1000;
  const base   = SEED_PRICES[symbol.toUpperCase()] || 100;
  const vol    = base * 0.012; // ~1.2% per-bar volatility
  const now    = Date.now();
  const seed   = strSeed(symbol + range + Math.floor(now / (24 * 3600 * 1000)));
  const rand   = mulberry32(seed);
  const result = [];

  let price = base;
  for (let i = 0; i < bars; i++) {
    const ts   = now - (bars - i) * intMs;
    const move = (rand() - 0.495) * vol;  // slight upward drift
    const open  = price;
    price      = Math.max(0.01, price + move);
    const high  = Math.max(open, price) * (1 + rand() * 0.004);
    const low   = Math.min(open, price) * (1 - rand() * 0.004);
    const volume = Math.round(base * 1000 + rand() * base * 2000);
    result.push({ ts, open: +open.toFixed(2), high: +high.toFixed(2),
                  low: +low.toFixed(2), close: +price.toFixed(2), volume });
  }
  return result;
}

class TradingPriceFeed {
  constructor(traderAgent = null) {
    this._agent   = traderAgent;
    this._cache   = new Map();   // key: `${symbol}:${range}`, value: { data, ts }
    this._cacheTTL = 60 * 1000; // 1 minute cache
  }

  /**
   * Get OHLCV bars for a symbol + range.
   * Returns { symbol, range, ticks, source, generated_at }
   */
  async getTicks(symbol, range = '1D') {
    const key = `${symbol.toUpperCase()}:${range}`;
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.ts < this._cacheTTL) return cached.data;

    let ticks  = null;
    let source = 'simulated';

    // Try live Alpaca via TraderAgent if available
    if (this._agent && typeof this._agent._callPython === 'function') {
      try {
        const res = await Promise.race([
          this._agent._callPython('get_bars', { ticker: symbol, timeframe: range }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        if (res && res.bars && res.bars.length > 0) {
          ticks  = res.bars.map(b => ({
            ts:     new Date(b.t || b.ts || b.timestamp).getTime(),
            open:   +(b.o || b.open  || 0).toFixed(2),
            high:   +(b.h || b.high  || 0).toFixed(2),
            low:    +(b.l || b.low   || 0).toFixed(2),
            close:  +(b.c || b.close || 0).toFixed(2),
            volume: Math.round(b.v || b.volume || 0),
          }));
          source = 'live';
        }
      } catch (_) { /* fall through to simulation */ }
    }

    if (!ticks) ticks = simulateBars(symbol.toUpperCase(), range);

    const data = {
      symbol:       symbol.toUpperCase(),
      range,
      ticks,
      source,
      current_price: ticks.length ? ticks[ticks.length - 1].close : 0,
      open_price:    ticks.length ? ticks[0].open : 0,
      generated_at:  new Date().toISOString(),
    };

    this._cache.set(key, { data, ts: Date.now() });
    return data;
  }

  /** Fetch ticks for every symbol in a watchlist concurrently. */
  async getWatchlistTicks(watchlist, range = '1D') {
    const results = await Promise.all(
      watchlist.map(sym => this.getTicks(sym, range).catch(err => ({
        symbol: sym, range, ticks: [], source: 'error', error: err.message,
        current_price: 0, open_price: 0, generated_at: new Date().toISOString(),
      })))
    );
    return results;
  }

  clearCache() { this._cache.clear(); }
}

module.exports = { TradingPriceFeed, simulateBars };