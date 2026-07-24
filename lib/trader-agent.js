/**
 * Trader Agent — Local wrapper for Python trading logic
 *
 * This module wraps the Python agents.py trading logic as a callable service.
 * Instead of running agents.py in a separate process, it spawns targeted Python
 * operations on-demand and caches results for the configured interval.
 *
 * No external ports or services required — everything runs locally.
 */

const path = require('path');
const fs = require('fs');
// Per-user watchlists (each user curates their own; the autopilot trades each user's own
// list). `this.watchlist` is the UNION across users so the scan + price/bar collectors
// cover every watched symbol; per-user filtering happens in the autopilot loop.
const watchlistStore = require('./watchlist-store');
// Keyless Node-native price/bar source. Replaces the per-call Python→Alpaca
// subprocess for charts/prices, which paid ~8.7s of import cost per call (and
// failed entirely without Alpaca keys), so the charts never loaded. Order
// placement + broker account still go through Python/Alpaca below.
const yahoo = require('./market-data-yahoo');
// Node deterministic signal engine (SR zones, RSI, candle patterns, market
// structure, tesseract) — replaces the Python scan_market/get_zones subprocess.
// All TA now runs in-process from Yahoo bars; no python spawn, no Alpaca.
const signalEngine = require('./signal-engine');
// IBKR Client Portal Web API client — broker reads (account/positions/orders)
// + GATED order placement. Replaces the Python/Alpaca broker path.
const IbkrCpapi = require('./ibkr-cpapi');

class TraderAgent {
  constructor(config = {}) {
    this.config = config;
    this.cache = {};
    this.cacheExpiry = config.cacheExpiry || 60000; // 60s default
    // Backoff TTL for a FAILED market scan (#1861): shorter than cacheExpiry so
    // a transient failure recovers quickly, but long enough that a persistently
    // broken backend isn't re-scanning on every GET.
    this._scanFailTtl = config.scanFailTtl || 30000; // 30s
    this.watchlistPath = path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'watchlist.json');
    // Broker (IBKR Client Portal gateway) — fail-soft; reads return an honest
    // "not connected" when the gateway is down. Order placement is hard-gated.
    this.ibkr = new IbkrCpapi();
  }

  // The scan + collectors read the UNION of every user's watchlist so all watched
  // symbols have data. Per-user lists live in watchlist-store; edit them there.
  get watchlist() { return watchlistStore.allTickers(); }

  _parseWatchlist(envString) {
    if (!envString) return ['SPY', 'AAPL', 'TSLA', 'NVDA', 'AMD'];
    try {
      return JSON.parse(envString);
    } catch {
      return envString.split(',').map(s => s.trim());
    }
  }

  _loadWatchlist() {
    const readList = (p) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(parsed.tickers) && parsed.tickers.length > 0) return parsed.tickers;
      } catch { /* missing/invalid */ }
      return null;
    };
    // The LIVE watchlist is untracked runtime state (data/.../watchlist.json) so a
    // deploy / `git reset --hard` can't wipe the user's added tickers. Read it first.
    const live = readList(this.watchlistPath);
    if (live) return live;
    // Fresh checkout with no live file yet → seed from the tracked default, then the
    // env override, then the hardcoded starter list. The first add/remove writes the
    // live file, and from then on user edits persist across deploys.
    const seed = readList(path.join(path.dirname(this.watchlistPath), 'watchlist.seed.json'));
    return seed || this._parseWatchlist(process.env.TRADER_WATCHLIST);
  }

  _saveWatchlist() {
    fs.mkdirSync(path.dirname(this.watchlistPath), { recursive: true });
    fs.writeFileSync(this.watchlistPath, JSON.stringify({ tickers: this.watchlist }, null, 2));
  }

  /**
   * Add a ticker to the persisted watchlist
   */
  addTicker(ticker, userId = 'default') {
    const t = String(ticker || '').trim().toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(t)) {
      throw new Error('ticker must be 1-10 letters');
    }
    const list = watchlistStore.addTicker(userId, t);
    this.clearCache();
    return list;
  }

  /**
   * Remove a ticker from the persisted watchlist
   */
  removeTicker(ticker, userId = 'default') {
    const t = String(ticker || '').trim().toUpperCase();
    const list = watchlistStore.removeTicker(userId, t);
    this.clearCache();
    return list;
  }

  /**
   * Scan the market for trading signals using Python agents
   * Returns: { signals: [...], zones: {...}, timestamp, metadata }
   */
  async scanMarket() {
    const cacheKey = 'market_scan';
    const entry = this.cache[cacheKey];
    if (entry && entry.data) {
      // A *failed* scan is cached with a short TTL (#1861) so a persistently
      // broken backend is distinguishable from a still-warming one and we back
      // off instead of re-spawning a doomed 90s scan on every poll + the 60s
      // loop. A *good* scan keeps the normal cacheExpiry window.
      const ttl = entry.failed ? this._scanFailTtl : this.cacheExpiry;
      if (Date.now() - entry.time < ttl) return entry.data;
    }

    try {
      // Deterministic Node scan (SR zones + RSI + candles + structure +
      // tesseract) over the watchlist — runs in-process in well under a second,
      // replacing the old 45-60s Python→Alpaca subprocess.
      const result = await signalEngine.scanAll(this.watchlist);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error('[TraderAgent] Market scan failed:', error.message);
      const fallback = {
        signals: [],
        zones: {},
        timestamp: new Date().toISOString(),
        error: error.message,
      };
      // Cache the FAILURE (#1861): the zones route reads this to serve an honest
      // "scan unavailable — <reason>" instead of an eternal "warming up", and
      // the short TTL means the next poll after the backoff window retries.
      this.cache[cacheKey] = { data: fallback, time: Date.now(), failed: true };
      return fallback;
    }
  }

  /**
   * Get market zones for a specific ticker
   * Returns: { support, resistance, trend, volatility, strength, touches }
   */
  async getZones(ticker) {
    const cacheKey = `zones_${ticker}`;
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < this.cacheExpiry) {
      return this.cache[cacheKey].data;
    }

    try {
      const result = await signalEngine.getZones(ticker);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error(`[TraderAgent] Zones for ${ticker} failed:`, error.message);
      return this._staleOr(cacheKey, {
        ticker,
        available: false,
        reason: this._shortReason(error),
      });
    }
  }

  /**
   * Validate a ticker symbol is a real, tradable asset before adding it to the
   * watchlist (#1624). Uses the keyless Yahoo quote probe (#1860) instead of the
   * Python→Alpaca lookup, which paid the ~7s cold-spawn cost and timed out —
   * breaking "+ Add symbol" search + validation entirely (#1859).
   * Returns { valid, tradable, symbol, name, asset_class, price?, reason }.
   */
  async validateSymbol(ticker) {
    return yahoo.validateSymbol(ticker);
  }

  // All tradable Alpaca assets for the symbol-search popup (#1692). Big list, so
  // cache it for an hour and filter per query in the route (not per-call Python).
  async getAllAssets() {
    const cacheKey = 'all_assets';
    const entry = this.cache[cacheKey];
    if (entry && Date.now() - entry.time < 3600000) {
      return entry.data;
    }
    // The full fuzzy asset universe used to come from Alpaca's list_assets. IBKR's
    // read-only CPAPI has no bulk symbol dump, so we no longer ship a universe here
    // — the search route's keyless Yahoo exact-ticker probe (validateSymbol)
    // resolves "+ Add symbol" instantly without it.
    void entry;
    return [];
  }

  /**
   * Analyze a specific signal (enrich with ticker, confidence scoring)
   * Returns: { symbol, action, reason, confidence, timestamp }
   */
  async analyzeSignal(signal) {
    // Signal enrichment is handled inline by the Node scan engine now; the old
    // Python 'analyze_signal' path never existed as a cli.py handler. No-op.
    return (signal && signal.symbol) ? { ...signal, analyzed: false } : null;
  }

  /**
   * Get real-time market status
   * Returns: { market_open, vix, vix_regime, spy_trend, day_pnl_pct }
   */
  async getMarketStatus() {
    const cacheKey = 'market_status';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 30000) { // 30s
      return this.cache[cacheKey].data;
    }

    try {
      // Keyless Yahoo path (#1860): VIX / regime / SPY trend / session open with
      // no Python spawn. Broker-only fields (equity, day P&L) come via
      // getPositions, so they're intentionally absent here.
      const result = await yahoo.getMarketStatus();

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return this.cache[cacheKey].data;
    } catch (error) {
      console.error('[TraderAgent] Market status failed:', error.message);
      // Serve last-good (stale) if we have it; otherwise an honest "unavailable"
      // status — NOT a 200-wrapped traceback and NOT regime "UNKNOWN" (#1226).
      return this._staleOr(cacheKey, {
        market_open: false,
        vix: 0,
        vix_regime: 'UNAVAILABLE',
        available: false,
        reason: this._shortReason(error),
      });
    }
  }

  /**
   * Get watchlist with current prices
   * Returns: [{ ticker, price, chg_pct, is_crypto }, ...]
   */
  async getWatchlistPrices() {
    const cacheKey = 'watchlist_prices';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 30000) { // 30s — Alpaca rate-limit headroom (16 tickers x ~2 calls/ticker)
      return this.cache[cacheKey].data;
    }

    try {
      const result = await yahoo.getQuotes(this.watchlist);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error('[TraderAgent] Watchlist prices failed:', error.message);
      return this._staleOr(cacheKey, []); // last-good prices if any, else empty (#1227)
    }
  }

  /**
   * Get open positions from Alpaca
   * Returns: { positions: [...], account: {...} }
   */
  async getOrders(limit = 50) {
    // Broker-truth order history from Alpaca (engine + manual). Cached 45s — it
    // changes only when a trade fires, and the cold Python spawn + Alpaca call can
    // run ~10s, so a short cache would re-spawn on every poll. 20s call timeout
    // (fastTimeout's 7s is too tight for the cold spawn).
    const cacheKey = 'orders';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 45000) {
      return this.cache[cacheKey].data;
    }
    try {
      const status = await this.ibkr.getStatus();
      if (!status.connected) {
        return { orders: [], count: 0, available: false, source: 'ibkr',
          reason: (status.evidence && status.evidence[status.evidence.length - 1]) || 'IBKR gateway not connected' };
      }
      const live = await this.ibkr.getLiveOrders();
      const orders = live.map((o) => ({
        id: o.orderId, symbol: o.symbol, side: String(o.side || '').toLowerCase(),
        qty: o.qty, filled_qty: o.filledQty, type: String(o.orderType || '').toLowerCase(),
        status: o.status, limit_price: o.price, filled_avg_price: o.avgPrice,
      }));
      const result = { orders, count: orders.length, source: 'ibkr', available: true };
      this.cache[cacheKey] = { data: result, time: Date.now() };
      return result;
    } catch (error) {
      console.error('[TraderAgent] Get orders failed:', error.message);
      return this._staleOr(cacheKey, { orders: [], count: 0, error: error.message });
    }
  }

  async getPositions() {
    const cacheKey = 'positions';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 60000) { // 60s
      return this.cache[cacheKey].data;
    }

    try {
      const status = await this.ibkr.getStatus();
      if (!status.connected) {
        return {
          positions: [], account: { equity: 0, cash: 0, buying_power: 0 },
          available: false, source: 'ibkr',
          reason: (status.evidence && status.evidence[status.evidence.length - 1]) || 'IBKR gateway not connected',
        };
      }
      const [summary, rawPos, pnl] = await Promise.all([
        this.ibkr.getAccountSummary(),
        this.ibkr.getPositions(),
        this.ibkr.getPnl().catch(() => null), // day P&L is best-effort — never fail the panel on it
      ]);
      const positions = (rawPos || []).map((p) => ({
        symbol: p.symbol, qty: p.qty, avg_entry_price: p.avgPrice,
        current_price: p.currentPrice, side: (p.qty >= 0 ? 'long' : 'short'),
        market_value: p.marketValue, unrealized_pl: p.unrealizedPnl,
      }));
      const equity = (summary && summary.equity) || 0;
      // Broker-authoritative P&L (IBKR /pnl/partitioned): `dpl` is the DAY change (reconciles
      // with equity − prior-close), `upl` is today's unrealized. So the panel adds up:
      //   Realized(today) + Unrealized = (dpl − upl) + upl = dpl = Day P&L.
      // Falls back to the summary's unrealized when the pnl endpoint is unavailable.
      const dayPnl = pnl && Number.isFinite(pnl.dailyPnl) ? pnl.dailyPnl : null;
      const unrealized = (pnl && Number.isFinite(pnl.unrealizedPnl))
        ? pnl.unrealizedPnl
        : ((summary && summary.unrealizedPnl) || 0);
      const realizedToday = (dayPnl != null && Number.isFinite(unrealized))
        ? Math.round((dayPnl - unrealized) * 100) / 100 : null;
      const account = {
        equity,
        cash: (summary && summary.cash) || 0,
        buying_power: (summary && (summary.buyingPower != null ? summary.buyingPower : summary.cash)) || 0,
        unrealized,
        pnl_today: dayPnl,          // header + panel Day P&L
        realized_today: realizedToday, // panel Realized P&L (reconciles: R + U = Day)
        day_pnl_pct: (dayPnl != null && equity) ? Math.round((dayPnl / equity) * 10000) / 100 : null,
        mode: status.mode,
      };
      const result = { positions, account, source: 'ibkr', available: true };
      this.cache[cacheKey] = { data: result, time: Date.now() };
      return result;
    } catch (error) {
      console.error('[TraderAgent] Get positions failed:', error.message);
      return this._staleOr(cacheKey, {
        positions: [], account: { equity: 0, cash: 0, buying_power: 0 },
        available: false, reason: this._shortReason(error),
      });
    }
  }

  /**
   * Get OHLCV bars for a ticker
   * Returns: { bars: [...], ticker, timeframe, count }
   */
  async getBars(ticker, timeframe = '1h') {
    const cacheKey = `bars_${ticker}_${timeframe}`;
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 60000) { // 60s
      return this.cache[cacheKey].data;
    }

    try {
      const result = await yahoo.getBars(ticker, timeframe);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error(`[TraderAgent] Get bars ${ticker} failed:`, error.message);
      return this._staleOr(cacheKey, { bars: [], ticker, timeframe, available: false, reason: this._shortReason(error) });
    }
  }

  /**
   * Place an order via IBKR — HARD-GATED and DRY BY DEFAULT (lib/trading-guard.js).
   * With TRADER_LIVE unset this returns { status:'dry_run', dry:true, reason } and
   * never contacts the broker. stop_loss/take_profit are passed through as metadata
   * only for now (CPAPI bracket legs are a follow-up; not auto-placed here).
   * Returns: { status:'placed'|'dry_run'|'error', order_id, ticker, side, qty, type, dry, reason, mode }.
   */
  async placeOrder({ ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit }) {
    const r = await this.ibkr.placeOrder({
      symbol: ticker,
      side,
      qty,
      orderType: String(type || 'market').toLowerCase() === 'limit' ? 'LMT' : 'MKT',
      price: limitPrice,
      tif: String(timeInForce || 'day').toLowerCase() === 'gtc' ? 'GTC' : 'DAY',
    });
    const out = {
      status: r.status === 'submitted' ? 'placed' : r.status, // placed | dry_run | error
      order_id: r.orderId || null,
      ticker, side, qty, type: type || 'market',
      dry: !!r.dry,
      reason: r.note || r.error || (r.gate && r.gate.reason) || null,
      mode: r.gate && r.gate.mode,
      stop_loss: stopLoss || null,
      take_profit: takeProfit || null,
    };
    if (r.status === 'submitted') this.clearCache();
    return out;
  }

  /**
   * Get OHLCV bars for multiple tickers in one subprocess call (used for
   * chart refreshes — far cheaper than one call per ticker).
   * Returns: { bars: { TICKER: { bars: [...], count } }, timeframe }
   */
  async getBarsMulti(tickers, timeframe = '5m') {
    const cacheKey = `bars_multi_${timeframe}`;
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 20000) { // 20s
      return this.cache[cacheKey].data;
    }

    try {
      const result = await yahoo.getBarsMulti(tickers, timeframe);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error('[TraderAgent] Get bars multi failed:', error.message);
      return this._staleOr(cacheKey, { bars: {}, timeframe, available: false, reason: this._shortReason(error) });
    }
  }

  /**
   * Clear cache (useful for testing or forcing refresh)
   */
  clearCache() {
    this.cache = {};
  }

  // Collapse a multi-line error into a single short reason so an
  // endpoint never returns a raw traceback in its body (#1226). Prefer the last
  // non-empty stderr line (the actual exception), strip our own wrapper noise.
  _shortReason(error) {
    let msg = (error && error.message) || String(error || 'unavailable');
    msg = msg.replace(/^Python error \([^)]*\):\s*/, '');
    const lines = msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines.length ? lines[lines.length - 1] : msg;
    return last.slice(0, 160);
  }

  // Return the last successfully-cached value for a key (even if past its
  // freshness window), tagged stale, so a transient provider failure degrades to
  // last-good data instead of blanking the UI (#1227/#1230). Falls back otherwise.
  _staleOr(cacheKey, fallback) {
    const c = this.cache[cacheKey];
    if (c && c.data != null) {
      const age = Date.now() - c.time;
      if (Array.isArray(c.data)) return c.data;
      if (typeof c.data === 'object') return { ...c.data, stale: true, stale_age_ms: age };
      return c.data;
    }
    return fallback;
  }

}

module.exports = TraderAgent;
