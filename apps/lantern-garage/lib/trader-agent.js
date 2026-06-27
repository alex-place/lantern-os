/**
 * Trader Agent — Local wrapper for Python trading logic
 *
 * This module wraps the Python agents.py trading logic as a callable service.
 * Instead of running agents.py in a separate process, it spawns targeted Python
 * operations on-demand and caches results for the configured interval.
 *
 * No external ports or services required — everything runs locally.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
// Keyless Node-native price/bar source. Replaces the per-call Python→Alpaca
// subprocess for charts/prices, which paid ~8.7s of import cost per call (and
// failed entirely without Alpaca keys), so the charts never loaded. Order
// placement + broker account still go through Python/Alpaca below.
const yahoo = require('./market-data-yahoo');

class TraderAgent {
  constructor(config = {}) {
    this.config = config;
    this.pythonPath = path.join(__dirname, '../../../src/trading_agents');
    this.cache = {};
    this.cacheExpiry = config.cacheExpiry || 60000; // 60s default
    this.pythonTimeout = config.pythonTimeout || 30000; // 30s timeout (scans)
    // Fast-fail budget for interactive reads (market-status / zones / bars /
    // watchlist) so a slow/broken data provider returns quickly instead of
    // hanging the page for the full 30s (#1227).
    this.fastTimeout = config.fastTimeout || parseInt(process.env.TRADER_PYTHON_FAST_TIMEOUT || '7000', 10);
    this.alpacaKey = process.env.ALPACA_API_KEY;
    this.alpacaSecret = process.env.ALPACA_SECRET_KEY;
    this.watchlistPath = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'watchlist.json');
    this.watchlist = this._loadWatchlist();

    // Limit concurrent Python subprocesses — running too many at once (e.g. on
    // initial dashboard load, which fires ~6 calls simultaneously) makes each
    // one slow enough to blow past pythonTimeout even though a single call
    // normally finishes in well under it.
    this._pyQueue = [];
    this._pyActive = 0;
    this._pyConcurrency = config.pythonConcurrency || 3;
  }

  _parseWatchlist(envString) {
    if (!envString) return ['SPY', 'AAPL', 'TSLA', 'NVDA', 'AMD'];
    try {
      return JSON.parse(envString);
    } catch {
      return envString.split(',').map(s => s.trim());
    }
  }

  _loadWatchlist() {
    try {
      const raw = fs.readFileSync(this.watchlistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tickers) && parsed.tickers.length > 0) {
        return parsed.tickers;
      }
    } catch {
      // file missing or invalid — fall back to env/default
    }
    return this._parseWatchlist(process.env.TRADER_WATCHLIST);
  }

  _saveWatchlist() {
    fs.mkdirSync(path.dirname(this.watchlistPath), { recursive: true });
    fs.writeFileSync(this.watchlistPath, JSON.stringify({ tickers: this.watchlist }, null, 2));
  }

  /**
   * Add a ticker to the persisted watchlist
   */
  addTicker(ticker) {
    const t = String(ticker || '').trim().toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(t)) {
      throw new Error('ticker must be 1-10 letters');
    }
    if (!this.watchlist.includes(t)) {
      this.watchlist.push(t);
      this._saveWatchlist();
      this.clearCache();
    }
    return this.watchlist;
  }

  /**
   * Remove a ticker from the persisted watchlist
   */
  removeTicker(ticker) {
    const t = String(ticker || '').trim().toUpperCase();
    const next = this.watchlist.filter((x) => x !== t);
    if (next.length !== this.watchlist.length) {
      this.watchlist = next;
      this._saveWatchlist();
      this.clearCache();
    }
    return this.watchlist;
  }

  /**
   * Scan the market for trading signals using Python agents
   * Returns: { signals: [...], zones: {...}, timestamp, metadata }
   */
  async scanMarket() {
    const cacheKey = 'market_scan';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < this.cacheExpiry) {
      return this.cache[cacheKey].data;
    }

    try {
      // Scanning the full watchlist (16 tickers, technical analysis per
      // ticker) regularly takes 45-60s — well beyond the default
      // pythonTimeout, so give it its own longer budget.
      const result = await this._callPython('scan_market', {
        watchlist: this.watchlist
      }, 90000);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error('[TraderAgent] Market scan failed:', error.message);
      // Return fallback with empty data
      return {
        signals: [],
        zones: {},
        timestamp: new Date().toISOString(),
        error: error.message
      };
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
      const result = await this._callPython('get_zones', { ticker }, this.fastTimeout);

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
   * Analyze a specific signal (enrich with ticker, confidence scoring)
   * Returns: { symbol, action, reason, confidence, timestamp }
   */
  async analyzeSignal(signal) {
    try {
      return await this._callPython('analyze_signal', signal);
    } catch (error) {
      console.error('[TraderAgent] Signal analysis failed:', error.message);
      return null;
    }
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
      const result = await this._callPython('get_market_status', {}, this.fastTimeout);

      this.cache[cacheKey] = {
        data: { ...result, available: true },
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
  async getPositions() {
    const cacheKey = 'positions';
    if (this.cache[cacheKey] && Date.now() - this.cache[cacheKey].time < 60000) { // 60s
      return this.cache[cacheKey].data;
    }

    try {
      const result = await this._callPython('get_positions', {
        alpaca_key: this.alpacaKey,
        alpaca_secret: this.alpacaSecret
      }, this.fastTimeout);

      this.cache[cacheKey] = {
        data: result,
        time: Date.now()
      };

      return result;
    } catch (error) {
      console.error('[TraderAgent] Get positions failed:', error.message);
      // Honest "not connected" — don't present 0 equity as live truth (#1230).
      return this._staleOr(cacheKey, {
        positions: [],
        account: { equity: 0, cash: 0, buying_power: 0 },
        available: false,
        reason: this._shortReason(error),
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
   * Place a manual paper order (buy/sell) via Alpaca, optionally with a
   * stop-loss / take-profit bracket.
   * Returns: { status: 'placed'|'error', order_id, ticker, side, qty, type, submitted_at }
   */
  async placeOrder({ ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit }) {
    const result = await this._callPython('place_order', {
      ticker, side, qty, type, limit_price: limitPrice, time_in_force: timeInForce,
      stop_loss: stopLoss, take_profit: takeProfit,
    });
    if (result && result.status === 'placed') this.clearCache();
    return result;
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

  /**
   * Call Python trading agent via subprocess, queued so that at most
   * `_pyConcurrency` subprocesses run at once.
   *
   * @param {string} action - Function to call (e.g., 'scan_market', 'get_zones')
   * @param {object} args - Arguments to pass to the function
   * @returns {Promise<object>} Parsed JSON response from Python
   */
  // Collapse a multi-line Python traceback into a single short reason so an
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

  _callPython(action, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      this._pyQueue.push({ action, args, timeoutMs, resolve, reject });
      this._drainPyQueue();
    });
  }

  _drainPyQueue() {
    while (this._pyActive < this._pyConcurrency && this._pyQueue.length > 0) {
      const job = this._pyQueue.shift();
      this._pyActive++;
      this._runPython(job.action, job.args, job.timeoutMs)
        .then(job.resolve, job.reject)
        .finally(() => {
          this._pyActive--;
          this._drainPyQueue();
        });
    }
  }

  /**
   * Spawn a Python process that imports the trading agents module, calls the
   * requested function with arguments, and returns JSON output.
   */
  _runPython(action, args, timeoutMs) {
    const effectiveTimeout = timeoutMs || this.pythonTimeout;
    return new Promise((resolve, reject) => {
      // Validate Python path exists
      if (!fs.existsSync(this.pythonPath)) {
        return reject(new Error(`Python trading_agents path not found: ${this.pythonPath}`));
      }

      // Build Python command
      const pythonScript = path.join(__dirname, '../../../src/trading_agents/cli.py');
      if (!fs.existsSync(pythonScript)) {
        return reject(new Error(`Python CLI script not found: ${pythonScript}`));
      }

      // Prepare environment
      const env = {
        ...process.env,
        PYTHONPATH: this.pythonPath,
        ALPACA_API_KEY: this.alpacaKey,
        ALPACA_SECRET_KEY: this.alpacaSecret,
        PYTHONUNBUFFERED: '1'
      };

      // Spawn Python process
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, effectiveTimeout);

      const proc = spawn('python', [pythonScript, action, JSON.stringify(args)], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: effectiveTimeout
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (timedOut) {
          return reject(new Error(`Python process timeout (${effectiveTimeout}ms) for action: ${action}`));
        }

        if (code !== 0) {
          return reject(new Error(`Python error (${action}): ${stderr || stdout}`));
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (parseError) {
          reject(new Error(`Failed to parse Python output for ${action}: ${parseError.message}\nOutput: ${stdout.slice(0, 200)}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });
    });
  }
}

module.exports = TraderAgent;
