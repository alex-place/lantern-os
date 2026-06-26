/**
 * Trading API Routes
 * Serves market data, AI recommendations, and broker integration
 * Integrates with local TraderAgent (Python subprocess) for single-app architecture
 */

const http = require('http');
const TradingAPIBridge = require('../lib/trading-api-bridge');
const TraderAgent = require('../lib/trader-agent');
const tradingMemory = require('../lib/trading-memory');
const tradingStore = require('../lib/trading-store');
const tradingNews = require('../lib/trading-news');
const { recordOrder, recordSignal, queryRecentTradingRecords } = tradingMemory;
const { TradingPriceFeed } = require('../lib/trader-price-feed');
const { getStrategyFitness, logPerformance } = require('../lib/strategy-performance-logger');
const tradeHistory = require('../lib/trading-history-logger');

// Shared price feed instance (caches ticks for 1 min)
let _priceFeed = null;
function getPriceFeed() {
  if (!_priceFeed) _priceFeed = new TradingPriceFeed(traderAgent);
  return _priceFeed;
}

// Initialize local trader agent (replaces external AI Trader service)
let traderAgent = null;
try {
  traderAgent = new TraderAgent({
    cacheExpiry: parseInt(process.env.TRADER_CACHE_EXPIRY || '60000'),
    pythonTimeout: parseInt(process.env.TRADER_PYTHON_TIMEOUT || '30000')
  });
} catch (e) {
  console.error('[Trading Routes] Failed to initialize TraderAgent:', e.message);
}

const AI_TRADER_HOST = process.env.AI_TRADER_HOST || '127.0.0.1';
const AI_TRADER_PORT = process.env.AI_TRADER_PORT || 5555;

const AI_TRADER_DASHBOARD_HOST = process.env.AI_TRADER_DASHBOARD_HOST || '127.0.0.1';
const AI_TRADER_DASHBOARD_PORT = process.env.AI_TRADER_DASHBOARD_PORT || 5050;

/**
 * Helper to call AI trader microservice
 */
function callAITrader(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: AI_TRADER_HOST,
      port: AI_TRADER_PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: data ? JSON.parse(data) : null
          });
        } catch (e) {
          reject(new Error('Invalid JSON response from AI trader'));
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI trader service timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Helper to call the AI Trader dashboard service (dashboard.py, port 5050)
 */
function callDashboard(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: AI_TRADER_DASHBOARD_HOST,
      port: AI_TRADER_DASHBOARD_PORT,
      path,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response from trading dashboard service'));
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Trading dashboard service timeout'));
    });

    req.end();
  });
}

// Proxy map for the LanternOS-hosted /trading.html and /trading-news.html
// pages, which talk to a single origin (this server) instead of the
// AI Trader dashboard's own port (5050).
//
// NOTE — legacy/optional: this proxies to an EXTERNAL AI Trader dashboard
// service (dashboard.py, port 5050) and is not required for any LanternOS
// feature. Trading memory (orders, agent-log/signals, CSF-backed queries)
// is served from local data by the routes below — no port 5050 required.
const DASHBOARD_PROXY_ROUTES = {
  '/api/trading/dashboard/positions': '/api/positions',
  '/api/trading/dashboard/market-status': '/api/market-status',
  '/api/trading/dashboard/zones': '/api/zones',
  '/api/trading/dashboard/watchlist-prices': '/api/watchlist-prices',
  '/api/trading/dashboard/agent-log': '/api/agent-log',
  '/api/trading/dashboard/orders': '/api/orders',
  '/api/trading/dashboard/news-feed': '/api/news-feed',
};

// trading.html itself fetches these same dashboard paths directly (bare,
// against this server's own origin) rather than via /api/trading/dashboard/*
// — proxy them 1:1 to the dashboard service (port 5050) too, including the
// /demo variants used when the "Demo Data" toggle is on.
const DIRECT_DASHBOARD_PROXY_PATHS = new Set([
  '/api/positions',
  '/api/positions/demo',
  '/api/market-status',
  '/api/market-status/demo',
  '/api/watchlist-prices',
  '/api/watchlist-prices/demo',
  '/api/ai-trader/signals',
  '/api/ai-trader/signals/demo',
]);

module.exports = async function tradingRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const bridge = new TradingAPIBridge();

  // ── Integrated Trader Agent Routes (Local, Single-App Model) ──────────────

  // GET /api/trading/zones
  // Market zones (support/resistance) from local trader agent
  if (url.pathname === '/api/trading/zones' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, { zones: {}, error: 'TraderAgent not initialized' }, 503);
    }
    try {
      // Never block a page GET on a fresh 90s market scan (#1227). Serve the
      // last-good cached scan instantly; warm/refresh the cache in the background.
      // Cold cache → honest "not ready" now; data appears on a later poll.
      const cacheEntry = traderAgent.cache && traderAgent.cache['market_scan'];
      if (!cacheEntry || !cacheEntry.data) {
        traderAgent.scanMarket().catch(() => {}); // background warm
        return sendJson(res, { zones: {}, available: false, reason: 'market scan warming up — data not ready yet' }, 200);
      }
      const scanFresh = (Date.now() - cacheEntry.time) < traderAgent.cacheExpiry;
      if (!scanFresh) traderAgent.scanMarket().catch(() => {}); // refresh in background, serve stale now
      const scan = cacheEntry.data;
      const signals = Array.isArray(scan.signals) ? scan.signals : [];
      if (!scan.error) {
        const logEntries = [
          {
            id: `scan_${scan.timestamp}_summary`,
            agent: 'scanner',
            action: `Scanned ${scan.watchlist_count ?? '?'} tickers — ${signals.length} signal${signals.length === 1 ? '' : 's'}`,
            symbol: '',
            timestamp: scan.timestamp,
          },
          ...signals.filter((s) => s && s.symbol).map((s) => ({
            id: `scan_${scan.timestamp}_${s.symbol}`,
            agent: s.agent || 'scanner',
            action: s.direction || s.action || s.status || 'signal',
            symbol: s.symbol,
            confidence: s.confidence,
            timestamp: scan.timestamp,
          })),
        ];
        tradingMemory.recordNewSignals({ logs: logEntries }).catch((e) => {
          console.error('[Trading] /zones agent-log write failed:', e.message);
        });
      }

      // Reshape into the per-ticker shape trader-dashboard.html expects:
      // { zones: [...], position, last_signal, confidence, direction, catalyst }
      let positions = [];
      try {
        const posData = await traderAgent.getPositions();
        positions = (posData && posData.positions) || [];
      } catch (e) {
        console.error('[Trading] /zones positions fetch failed:', e.message);
      }
      const reshaped = {};
      const tickers = new Set([
        ...Object.keys(scan.zones || {}),
        ...signals.map((s) => s.symbol || s.ticker).filter(Boolean),
      ]);
      for (const ticker of tickers) {
        const sig = signals.find((s) => (s.symbol || s.ticker) === ticker) || null;
        const pos = positions.find((p) => p.symbol === ticker) || null;
        reshaped[ticker] = {
          zones: scan.zones && scan.zones[ticker] ? [scan.zones[ticker]] : [],
          position: pos ? { entry: pos.avg_entry_price, current: pos.current_price, qty: pos.qty, pnl_pct: pos.pnl_pct } : null,
          last_signal: sig,
          confidence: (sig && sig.confidence) || 0,
          direction: (sig && sig.direction) || 'NEUTRAL',
          catalyst: (sig && sig.catalyst) || '',
        };
      }
      sendJson(res, { zones: reshaped }, 200);
    } catch (error) {
      console.error('[Trading] /zones error:', error.message);
      sendJson(res, { zones: {}, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/watchlist-prices
  // Live prices for monitored tickers
  if (url.pathname === '/api/trading/watchlist-prices' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, [], 503);
    }
    try {
      const prices = await traderAgent.getWatchlistPrices();
      sendJson(res, prices || [], 200);
    } catch (error) {
      console.error('[Trading] /watchlist-prices error:', error.message);
      sendJson(res, [], 500);
    }
    return true;
  }

  // GET /api/trading/bars-multi?timeframe=5m
  // OHLCV bars for the whole watchlist in one subprocess call — used to
  // draw the candlestick/line charts on the trader dashboard.
  if (url.pathname === '/api/trading/bars-multi' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, { bars: {} }, 503);
    }
    const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
    const timeframeParam = url.searchParams.get('timeframe') || '5m';
    const timeframe = ALLOWED_TIMEFRAMES.has(timeframeParam) ? timeframeParam : '5m';
    try {
      const result = await traderAgent.getBarsMulti(traderAgent.watchlist, timeframe);
      sendJson(res, result, 200);
    } catch (error) {
      console.error('[Trading] /bars-multi error:', error.message);
      sendJson(res, { bars: {}, timeframe, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/positions
  // Open positions from Alpaca
  if (url.pathname === '/api/trading/positions' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, { positions: [], account: {} }, 503);
    }
    try {
      const positions = await traderAgent.getPositions();
      sendJson(res, positions, 200);
    } catch (error) {
      console.error('[Trading] /positions error:', error.message);
      sendJson(res, { positions: [], account: {} }, 500);
    }
    return true;
  }

  // GET /api/trading/market-status
  // Market status (VIX, SPY trend, market hours)
  if (url.pathname === '/api/trading/market-status' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, { market_open: false }, 503);
    }
    try {
      const status = await traderAgent.getMarketStatus();
      sendJson(res, status, 200);
    } catch (error) {
      console.error('[Trading] /market-status error:', error.message);
      sendJson(res, { market_open: false, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/agent-log
  // Recent agent activity log (from local memory or CSF)
  if (url.pathname === '/api/trading/agent-log' && req.method === 'GET') {
    try {
      // Query recent signal records from CSF memory (via trading-memory.js)
      const records = queryRecentTradingRecords(20, 'signal');
      const logs = records.map(r => ({
        time: r.created_at ? new Date(r.created_at).toLocaleTimeString() : '',
        type: 'signal',
        agent: r.content.agent || 'trader',
        body: r.content.action || JSON.stringify(r.content).slice(0, 90)
      }));
      sendJson(res, logs, 200);
    } catch (error) {
      console.error('[Trading] /agent-log error:', error.message);
      sendJson(res, [], 500);
    }
    return true;
  }

  // GET /api/trading/orders
  // Real local paper-trade ledger — the SAME store that POST /api/trading/orders
  // and /orders/place write to (tradingStore), so a placed order shows up here.
  // Previously this read CSF memory, which surfaced a stale "shape-array" shape
  // fixture and never reflected placed orders (#1228).
  if (url.pathname === '/api/trading/orders' && req.method === 'GET') {
    try {
      const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
      const stored = tradingStore.listOrders(limitParam > 0 ? { limit: limitParam } : {});
      const orders = stored.slice().reverse().map((o) => ({
        id: o.id || o.order_id || '',
        symbol: o.symbol || o.ticker || '',
        side: o.side || '',
        qty: o.qty || 0,
        type: o.type || o.order_type || 'market',
        status: o.status || 'unknown',
        filled_at: o.filled_at || o.submitted_at || '',
        filled_avg: o.filled_avg || o.price || 0,
      }));
      sendJson(res, orders, 200);
    } catch (error) {
      console.error('[Trading] /orders error:', error.message);
      sendJson(res, [], 500);
    }
    return true;
  }

  // ── Trading memory: local orders & agent-log (Trading Phase 2, #323) ──────
  // LanternOS-native: reads/writes data/lantern-garage/trading/*.jsonl and
  // CSF Tier.TRACE records under data/csf_memory/ directly. No external
  // service, no Python process — works from a fresh checkout of this repo
  // alone.

  // GET /api/trading/dashboard/orders
  // Local order history, newest entries last (matches the order they were
  // recorded). Returns a bare array — trading.html does
  // `Array.isArray(orders)`.
  if (url.pathname === '/api/trading/dashboard/orders' && req.method === 'GET') {
    try {
      const limitParam = Number(url.searchParams.get('limit'));
      const orders = tradingStore.listOrders(limitParam > 0 ? { limit: limitParam } : {});
      sendJson(res, orders, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read local orders', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/dashboard/agent-log
  // Local agent/signal log, newest entries last. Returns a bare array —
  // trading.html does `Array.isArray(logs)`.
  if (url.pathname === '/api/trading/dashboard/agent-log' && req.method === 'GET') {
    try {
      const limitParam = Number(url.searchParams.get('limit'));
      const logs = tradingStore.listLogEntries({ limit: limitParam > 0 ? limitParam : 100 });
      sendJson(res, logs, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read local agent log', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/orders
  // Body: a single order object, `{ orders: [...] }`, or a bare array of
  // orders. Orders without an `id` get a local one generated. Persists into
  // the local trading store and into CSF memory as Tier.TRACE records
  // (tags: trading, order, <status>). Idempotent for repeated `id`s.
  if (url.pathname === '/api/trading/orders' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const orders = tradingMemory._toArray(payload, ['orders']);
      for (const order of orders) {
        if (order && !order.id) {
          order.id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }
      }
      const written = await tradingMemory.recordNewOrders(orders);
      sendJson(res, { recorded: written.length, orders: written }, 201);
    } catch (error) {
      sendJson(res, { error: 'Failed to record order', details: error.message }, 400);
    }
    return true;
  }

  // POST /api/trading/orders/place
  // Place a manual paper order (buy/sell) via Alpaca, routed through the
  // local TraderAgent → cli.py → Alpaca paper account.
  if (url.pathname === '/api/trading/orders/place' && req.method === 'POST') {
    if (!traderAgent) {
      return sendJson(res, { status: 'error', error: 'TraderAgent not initialized' }, 503);
    }
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const { ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit } = payload;
      if (!ticker || !['buy', 'sell'].includes(String(side || '').toLowerCase()) || !qty || Number(qty) <= 0) {
        return sendJson(res, { status: 'error', error: 'ticker, side (buy/sell), and positive qty are required' }, 400);
      }
      if (stopLoss != null && Number(stopLoss) <= 0) {
        return sendJson(res, { status: 'error', error: 'stopLoss must be a positive number' }, 400);
      }
      if (takeProfit != null && Number(takeProfit) <= 0) {
        return sendJson(res, { status: 'error', error: 'takeProfit must be a positive number' }, 400);
      }
      const result = await traderAgent.placeOrder({ ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit });
      if (result && result.status === 'placed') {
        await tradingMemory.recordNewOrders([{
          id: result.order_id,
          symbol: result.ticker,
          side: result.side,
          qty: result.qty,
          status: 'submitted',
          order_type: result.type,
        }]);
        sendJson(res, result, 201);
      } else {
        sendJson(res, result || { status: 'error', error: 'Unknown error' }, 400);
      }
    } catch (error) {
      sendJson(res, { status: 'error', error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/watchlist
  if (url.pathname === '/api/trading/watchlist' && req.method === 'GET') {
    if (!traderAgent) {
      return sendJson(res, { watchlist: [] }, 503);
    }
    sendJson(res, { watchlist: traderAgent.watchlist }, 200);
    return true;
  }

  // POST /api/trading/watchlist
  // Body: { ticker } — add a ticker to the persisted watchlist
  if (url.pathname === '/api/trading/watchlist' && req.method === 'POST') {
    if (!traderAgent) {
      return sendJson(res, { watchlist: [], error: 'TraderAgent not initialized' }, 503);
    }
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const watchlist = traderAgent.addTicker(payload.ticker);
      sendJson(res, { watchlist }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // DELETE /api/trading/watchlist/:ticker — remove a ticker from the watchlist
  if (req.method === 'DELETE') {
    const watchlistMatch = url.pathname.match(/^\/api\/trading\/watchlist\/([A-Za-z]{1,10})$/);
    if (watchlistMatch) {
      if (!traderAgent) {
        return sendJson(res, { watchlist: [], error: 'TraderAgent not initialized' }, 503);
      }
      const watchlist = traderAgent.removeTicker(watchlistMatch[1]);
      sendJson(res, { watchlist }, 200);
      return true;
    }
  }

  // POST /api/trading/agent-log
  // Body: a single agent-log entry, `{ logs: [...] }` / `{ agentLog: [...] }`
  // / `{ agent_log: [...] }`, or a bare array of entries. Entries without a
  // `time` get one generated. Persists into the local trading store and into
  // CSF memory as Tier.TRACE records (tags: trading, signal, <type>).
  if (url.pathname === '/api/trading/agent-log' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const entries = tradingMemory._toArray(payload, ['logs', 'agentLog', 'agent_log']);
      for (const entry of entries) {
        if (entry && !entry.time) {
          entry.time = new Date().toISOString();
        }
      }
      const written = await tradingMemory.recordNewSignals({ logs: entries });
      sendJson(res, { recorded: written.length, logs: written }, 201);
    } catch (error) {
      sendJson(res, { error: 'Failed to record agent-log entry', details: error.message }, 400);
    }
    return true;
  }

  // ── /trading.html + /trading-news.html dashboard proxy routes ─────────────
  // Legacy/optional — see DASHBOARD_PROXY_ROUTES note above. Not required
  // for trading memory (orders/agent-log/CSF), which is served above.
  // GET /api/trading/dashboard/{positions,market-status,zones,watchlist-prices,agent-log,orders,news-feed}
  if (req.method === 'GET' && DASHBOARD_PROXY_ROUTES[url.pathname]) {
    try {
      const proxyPath = DASHBOARD_PROXY_ROUTES[url.pathname];
      const data = await callDashboard(proxyPath);
      // CSF memory wiring: write orders, agent-log, and news to CSF on state change
      if (proxyPath === '/api/orders' && Array.isArray(data?.orders || data)) {
        const orders = data.orders || data;
        for (const o of orders) { recordOrder(o).catch(() => {}); }
      }
      if (proxyPath === '/api/agent-log' && Array.isArray(data?.logs || data)) {
        const logs = data.logs || data;
        for (const s of logs) { recordSignal(s).catch(() => {}); }
      }
      if (proxyPath === '/api/news-feed') {
        const items = [...(data?.ticker_news || []), ...(data?.broad_news || [])];
        for (const item of items) { tradingNews.recordNewsItem(item).catch(() => {}); }
      }
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 502);
    }
    return true;
  }

  // GET /api/{positions,market-status,watchlist-prices,ai-trader/signals}[/demo]
  // Bare-path proxy for trading.html's direct fetches — see
  // DIRECT_DASHBOARD_PROXY_PATHS above.
  if (req.method === 'GET' && DIRECT_DASHBOARD_PROXY_PATHS.has(url.pathname)) {
    try {
      const data = await callDashboard(url.pathname + (url.search || ''));
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 502);
    }
    return true;
  }

  // GET /api/trading/status
  // Returns real-time status of all connected APIs
  if (url.pathname === '/api/trading/status' && req.method === 'GET') {
    try {
      const data = await bridge.getDashboardData();
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ibkr/account
  // Returns IBKR account details
  if (url.pathname === '/api/trading/ibkr/account' && req.method === 'GET') {
    try {
      const account = await bridge.getIBKRAccount();
      sendJson(res, { account }, 200);
    } catch (error) {
      sendJson(res, { error: 'IBKR Gateway not available', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/ibkr/positions
  // Returns IBKR open positions
  if (url.pathname === '/api/trading/ibkr/positions' && req.method === 'GET') {
    try {
      const positions = await bridge.getIBKRPositions();
      sendJson(res, { positions }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch positions', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/kalshi/events
  // Returns KALSHI open events for prediction markets
  if (url.pathname === '/api/trading/kalshi/events' && req.method === 'GET') {
    try {
      const events = await bridge.getKALSHIEvents();
      sendJson(res, { events }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch KALSHI events', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/kalshi/markets
  // Returns the CIO collector's recorded Kalshi odds (read-only, from snapshots)
  if (url.pathname === '/api/trading/kalshi/markets' && req.method === 'GET') {
    try {
      const stats = require('../lib/kalshi-stats').getKalshiStats();
      sendJson(res, stats, 200);
    } catch (error) {
      sendJson(res, { error: 'Kalshi stats unavailable', details: error.message }, 503);
    }
    return true;
  }

  // ── Full Kalshi v2 API surface (for the on-dashboard terminal) ────────────
  // Read endpoints are public; portfolio + orders are RSA-signed & gated.
  if (url.pathname.startsWith('/api/trading/kalshi/') &&
      url.pathname !== '/api/trading/kalshi/events' &&
      url.pathname !== '/api/trading/kalshi/markets') {
    const kalshi = require('../lib/kalshi-api');
    const q = Object.fromEntries(url.searchParams.entries());
    try {
      // GET — connection & safety snapshot
      if (url.pathname === '/api/trading/kalshi/connection' && req.method === 'GET') {
        return sendJson(res, await kalshi.getConnection(), 200), true;
      }
      // GET — CIO suggestion deck (the "Tinder of trading" cards)
      if (url.pathname === '/api/trading/kalshi/suggestions' && req.method === 'GET') {
        const suggest = require('../lib/kalshi-suggest');
        const limit = q.limit ? Number(q.limit) : 60;
        const collector = deps.kalshiCollector || null;
        return sendJson(res, await suggest.getSuggestions({ limit, collector }), 200), true;
      }

      // GET — Convergence-optimized games (ideal time window + conviction + momentum)
      if (url.pathname === '/api/trading/kalshi/convergence-ranked' && req.method === 'GET') {
        const suggest = require('../lib/kalshi-suggest');
        const scorer = require('../lib/kalshi-convergence-scorer');
        const limit = q.limit ? Number(q.limit) : 12;
        const collector = deps.kalshiCollector || null;
        const suggestions = await suggest.getSuggestions({ limit: 200, collector });
        const ranked = scorer.rankByConvergence(suggestions.cards || [], limit);
        return sendJson(res, {
          count: ranked.length,
          note: 'Games ranked by convergence fitness: ideal time window (1-6h) + high conviction + strong momentum',
          cards: ranked
        }, 200), true;
      }

      // GET — Crypto intraday markets (15m, 1h, daily predictions)
      // GLOBAL TRADING-PAUSE GATE — when data/kalshi/TRADING-PAUSED exists, every
      // trade-suggestion deck returns ZERO cards. Engaged after the realized-PnL
      // backtest showed no edge after fees (experiments/kalshi_pnl_backtest.py);
      // remove the flag only once a strategy is proven net-profitable.
      if (req.method === 'GET' && kalshi.tradingPaused && kalshi.tradingPaused() && [
            '/api/trading/kalshi/crypto-intraday',
            '/api/trading/kalshi/impossibility-deck',
            '/api/trading/kalshi/decisive-deck',
            '/api/trading/kalshi/positions-deck',
          ].includes(url.pathname)) {
        return sendJson(res, {
          cards: [], count: 0, exitCount: 0, entryCount: 0, paused: true,
          generatedAt: new Date().toISOString(),
          note: 'TRADING PAUSED — all cards cleared. No strategy is proven net-profitable after fees. Remove data/kalshi/TRADING-PAUSED to re-enable.',
        }, 200), true;
      }

      if (url.pathname === '/api/trading/kalshi/crypto-intraday' && req.method === 'GET') {
        const cryptoSuggest = require('../lib/kalshi-crypto-suggester');
        const limit = q.limit ? Number(q.limit) : 20;
        const collector = deps.kalshiCollector || null;
        return sendJson(res, await cryptoSuggest.getCryptoSuggestions({ limit, collector }), 200), true;
      }

      // GET — Win rate stats (Phase 1 profitability data)
      if (url.pathname === '/api/trading/kalshi/winrate-stats' && req.method === 'GET') {
        const { computeWinRate } = require('../lib/kalshi-winrate-tracker');
        return sendJson(res, computeWinRate(), 200), true;
      }

      // POST — Start position monitor (automated stop-losses)
      if (url.pathname === '/api/trading/kalshi/monitor/start' && req.method === 'POST') {
        const { getMonitor } = require('../lib/kalshi-position-monitor');
        getMonitor().start();
        return sendJson(res, { status: 'monitoring started' }, 200), true;
      }

      // POST — Stop position monitor
      if (url.pathname === '/api/trading/kalshi/monitor/stop' && req.method === 'POST') {
        const { getMonitor } = require('../lib/kalshi-position-monitor');
        getMonitor().stop();
        return sendJson(res, { status: 'monitoring stopped' }, 200), true;
      }

      // GET — Get monitored positions
      if (url.pathname === '/api/trading/kalshi/monitor/positions' && req.method === 'GET') {
        const { getMonitor } = require('../lib/kalshi-position-monitor');
        const monitor = getMonitor();
        return sendJson(res, {
          monitoring: monitor.monitoring,
          positions: monitor.getMonitoredPositions(),
          readyToClose: monitor.getReadyToClose(),
          stats: monitor.getStats()
        }, 200), true;
      }

      // POST — Train convergence model from trade logs
      if (url.pathname === '/api/trading/kalshi/convergence/train' && req.method === 'POST') {
        const { trainModel } = require('../lib/kalshi-convergence-trainer');
        const result = await trainModel();
        return sendJson(res, result, 200), true;
      }

      // GET — Get convergence model and stats
      if (url.pathname === '/api/trading/kalshi/convergence/model' && req.method === 'GET') {
        const { getTrainer } = require('../lib/kalshi-convergence-trainer');
        const trainer = getTrainer();
        return sendJson(res, {
          model: trainer.getModel(),
          summary: trainer.getSummary()
        }, 200), true;
      }

      // GET — Get convergence accuracy for a ticker
      if (url.pathname === '/api/trading/kalshi/convergence/accuracy' && req.method === 'GET') {
        const ticker = q.ticker;
        if (!ticker) return sendJson(res, { error: 'ticker required' }, 400), true;
        const { getTrainer } = require('../lib/kalshi-convergence-trainer');
        const trainer = getTrainer();
        return sendJson(res, {
          ticker,
          accuracy: trainer.getAccuracy(ticker),
          multiplier: trainer.getTypeMultiplier(trainer.getMarketType(ticker))
        }, 200), true;
      }

      // POST — Start convergence enhancement loop (continuous self-improvement)
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/start' && req.method === 'POST') {
        const { startEnhancing } = require('../lib/kalshi-convergence-enhancer');
        startEnhancing();
        return sendJson(res, { status: 'enhancement started' }, 200), true;
      }

      // POST — Stop convergence enhancement loop
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/stop' && req.method === 'POST') {
        const { stopEnhancing } = require('../lib/kalshi-convergence-enhancer');
        stopEnhancing();
        return sendJson(res, { status: 'enhancement stopped' }, 200), true;
      }

      // GET — Get convergence enhancer status and predictions
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/status' && req.method === 'GET') {
        const ticker = q.ticker;
        const { getEnhancer } = require('../lib/kalshi-convergence-enhancer');
        const enhancer = getEnhancer();
        return sendJson(res, {
          status: enhancer.getStatus(),
          context: ticker ? enhancer.getContext(ticker) : null,
          prediction: ticker ? enhancer.getPrediction(ticker) : null
        }, 200), true;
      }

      // POST — Start LoRA fine-tuning analysis (proactive, continuous)
      if (url.pathname === '/api/trading/kalshi/convergence/lora/start' && req.method === 'POST') {
        const { startAnalyzing } = require('../lib/kalshi-convergence-lora');
        startAnalyzing();
        return sendJson(res, { status: 'LoRA analysis started' }, 200), true;
      }

      // POST — Stop LoRA analysis
      if (url.pathname === '/api/trading/kalshi/convergence/lora/stop' && req.method === 'POST') {
        const { stopAnalyzing } = require('../lib/kalshi-convergence-lora');
        stopAnalyzing();
        return sendJson(res, { status: 'LoRA analysis stopped' }, 200), true;
      }

      // GET — Get LoRA model status and training progress
      if (url.pathname === '/api/trading/kalshi/convergence/lora/status' && req.method === 'GET') {
        const { getLora } = require('../lib/kalshi-convergence-lora');
        const lora = getLora();
        return sendJson(res, {
          model: lora.getStatus(),
          training: lora.getTrainingSummary()
        }, 200), true;
      }

      // GET — Dashboard: Complete progress report
      if (url.pathname === '/api/trading/kalshi/dashboard/progress' && req.method === 'GET') {
        const { getReport } = require('../lib/kalshi-progress-report');
        const report = getReport().getReport();
        return sendJson(res, report, 200), true;
      }

      // GET — Dashboard: Quick overview
      if (url.pathname === '/api/trading/kalshi/dashboard/overview' && req.method === 'GET') {
        const { getReport } = require('../lib/kalshi-progress-report');
        const { getEnhancer } = require('../lib/kalshi-convergence-enhancer');
        const { getLora } = require('../lib/kalshi-convergence-lora');

        const report = getReport().getReport();
        const overview = {
          projectName: report.projectName,
          phases: Object.keys(report.phases).length,
          loops: Object.keys(report.trainingLoops).length,
          enhancerStatus: getEnhancer().getStatus(),
          loraStatus: getLora().getStatus(),
          generatedAt: new Date().toISOString()
        };
        return sendJson(res, overview, 200), true;
      }

      // GET — Real-Time Dashboard: Live positions + portfolio metrics
      if (url.pathname === '/api/trading/kalshi/realtime/dashboard' && req.method === 'GET') {
        try {
          const { buildDashboard, getRecentTrades, calculatePerformanceMetrics } = require('../lib/kalshi-realtime-dashboard');
          const dashboard = await buildDashboard();
          const recentTrades = getRecentTrades(20);
          const performanceMetrics = calculatePerformanceMetrics(recentTrades);
          return sendJson(res, { ...dashboard, recentTrades, performanceMetrics }, 200), true;
        } catch (e) {
          console.error('[Trading Routes] Real-time dashboard error:', e.message);
          return sendJson(res, { error: e.message }, 500), true;
        }
      }

      // GET — Impossibility Engine deck: constraint-elimination over short-window markets
      // Returns same card shape as crypto-intraday + { determined, stateLabel, knowledge, trace }
      if (url.pathname === '/api/trading/kalshi/impossibility-deck' && req.method === 'GET') {
        const { createKalshiEngine, engineResultToCard } = require('../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../lib/kalshi-crypto-suggester');
        const limit = q.limit ? Number(q.limit) : 20;
        const nowMs = Date.now();

        // Fetch short-window markets
        let markets = [];
        const collector = deps.kalshiCollector;
        if (collector) {
          const latest = collector.getLatestMarkets?.();
          if (latest && latest.length > 0) {
            markets = latest.filter(m => isShortWindowMarket(m, nowMs));
          }
        }
        if (markets.length === 0) {
          const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
          markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, nowMs));
        }

        if (markets.length === 0) {
          return sendJson(res, { count: 0, cards: [], note: 'No markets closing within 6 hours' }, 200), true;
        }

        const engine = createKalshiEngine();
        const solved = engine.solveAll(markets);
        const cards  = solved
          .slice(0, limit)
          .map(({ market, result }) => engineResultToCard(market, result));

        return sendJson(res, {
          count: cards.length,
          generatedAt: new Date().toISOString(),
          note: 'Impossibility Engine: constraint-elimination over short-window Kalshi markets',
          determined: cards.filter(c => c.determined).length,
          cards,
        }, 200), true;
      }

      // GET — Decisive Deck: ONE action per market (buy or sell, not both)
      // Consolidates all positions + suggestions into high-conviction trades only
      // WITH regime detection + strategy fitness scoring (Phase C MVP)
      if (url.pathname === '/api/trading/kalshi/decisive-deck' && req.method === 'GET') {
        const suggest = require('../lib/kalshi-suggest');
        const { createKalshiEngine, engineResultToCard } = require('../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../lib/kalshi-crypto-suggester');
        const cryptoSuggest = require('../lib/kalshi-crypto-suggester');
        const RegimeDetector = require('../lib/regime-detector');
        const performanceLogger = require('../lib/strategy-performance-logger');
        const strategyRegistry = require('../lib/strategy-registry');
        const sigma0Deck = require('../lib/sigma0-deck');
        const collector = deps.kalshiCollector || null;
        const nowMs = Date.now();
        // Σ₀ ranking knob: 0 = safety (lowest loss odds), 1 = return (largest delta)
        const riskAppetite = q.risk != null ? Number(q.risk) : 0.5;

        try {
          // Initialize regime detector
          const regimeDetector = new RegimeDetector();

          // Step 1: Get all suggestions in parallel
          const [suggestions, ieCards, cryptoCards] = await Promise.all([
            suggest.getSuggestions({ limit: 100, collector }),
            (async () => {
              let markets = [];
              if (collector) {
                const latest = collector.getLatestMarkets?.();
                if (latest?.length > 0) markets = latest.filter(m => isShortWindowMarket(m, nowMs));
              }
              if (markets.length === 0) {
                const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
                markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, nowMs));
              }
              if (markets.length === 0) return [];
              const engine = createKalshiEngine();
              const solved = engine.solveAll(markets);
              return solved.slice(0, 20).map(({ market, result }) => engineResultToCard(market, result));
            })(),
            cryptoSuggest.getCryptoSuggestions({ limit: 15, collector }).catch(() => ({ cards: [] })),
          ]);

          // Step 2: Extract cards from suggestions (already includes exits + entries)
          const existingCards = suggestions.cards || [];
          const cryptoCardsList = cryptoCards.cards || [];
          const allSignals = [...existingCards, ...ieCards, ...cryptoCardsList];

          // Step 3: Detect regime + score strategies per market
          const activeStrategies = strategyRegistry.getActiveStrategies();
          const strategyIds = activeStrategies.map(s => s.strategy_id);

          // Enrich cards with regime detection + strategy fitness
          const enrichedCards = allSignals.map(card => {
            // Detect regime for this market
            const regime = regimeDetector.detect(card.market || {});

            // Score available strategies for this regime
            const bestStrategy = performanceLogger.getBestStrategyForRegime(regime, strategyIds);

            return {
              ...card,
              regime,
              best_strategy: bestStrategy.strategy_id,
              strategy_fitness: bestStrategy.fitness,
              strategy_score: bestStrategy.score,
            };
          });

          // Step 4: Consolidate: one action per ticker (exits take priority)
          const decisiveMap = new Map();

          // Sort so exits come first, then by strategy fitness + conviction
          enrichedCards.sort((a, b) => {
            const aIsExit = a.kind === 'exit' ? 0 : 1;
            const bIsExit = b.kind === 'exit' ? 0 : 1;
            if (aIsExit !== bIsExit) return aIsExit - bIsExit;

            // Tie-breaker: strategy fitness score
            const aStrategyScore = a.strategy_score || 0;
            const bStrategyScore = b.strategy_score || 0;
            if (Math.abs(aStrategyScore - bStrategyScore) > 0.1) {
              return bStrategyScore - aStrategyScore;
            }

            // Final tie-breaker: conviction
            return (b.conviction || 0) - (a.conviction || 0);
          });

          // Take first action per ticker (exits first, then highest fitness strategy + conviction entry)
          for (const card of enrichedCards) {
            if (!decisiveMap.has(card.ticker)) {
              // Only add entries if conviction > 70% OR strategy has positive recent fitness
              const hasPositiveFitness = card.strategy_fitness?.pnl > 0;
              if (card.kind === 'exit' || (card.conviction || 0) >= 70 || hasPositiveFitness) {
                decisiveMap.set(card.ticker, card);
              }
            }
          }

          // Step 5: Legacy decisionScore (kept as a tiebreaker signal)
          const allCards = Array.from(decisiveMap.values());
          allCards.forEach(card => {
            const timeWeight = (card.minsToClose ?? 60) < 60 ? 1.2 : (card.minsToClose ?? 60) < 240 ? 1.0 : 0.7;
            const strategyWeight = Math.min(1.5, 1.0 + (card.strategy_fitness?.stability || 0.5) * 0.5);
            card.decisionScore = (card.conviction || 0) * timeWeight * strategyWeight;
          });

          // Step 5b: Σ₀ END-STATE RANKING — predict each card's attractor + a
          // contraction confidence, score by risk-adjusted capturable delta gated
          // by confidence (minimize loss / maximize gain per swipe). Exits keep
          // priority (not acting on a stop is itself a loss); within each group
          // Σ₀ score orders, with legacy decisionScore as the final tiebreaker.
          const scored = sigma0Deck.rankDeck(allCards, { riskAppetite });
          scored.sort((a, b) => {
            const aExit = a.kind === 'exit' ? 0 : 1, bExit = b.kind === 'exit' ? 0 : 1;
            if (aExit !== bExit) return aExit - bExit;
            const ds = (b.sigma0?.score || 0) - (a.sigma0?.score || 0);
            if (Math.abs(ds) > 1e-6) return ds;
            return (b.decisionScore || 0) - (a.decisionScore || 0);
          });

          // Step 6: Return top 6 trades (focused, decisive deck)
          const decisive = scored.slice(0, 6);

          return sendJson(res, {
            count: decisive.length,
            generatedAt: new Date().toISOString(),
            note: 'Decisive Deck: Σ₀ end-state ranking — risk-adjusted delta per swipe',
            riskAppetite,
            regime_stats: {
              regimes_detected: [...new Set(decisive.map(c => c.regime))],
              strategies_active: strategyIds,
            },
            cards: decisive.map(c => ({
              ...c,
              // Expose regime + strategy info + Σ₀ prediction for human validation
              regime: c.regime,
              best_strategy: c.best_strategy,
              strategy_fitness: c.strategy_fitness,
              sigma0: c.sigma0,
            })),
          }, 200), true;
        } catch (error) {
          console.error('[Decisive Deck] error:', error.message);
          return sendJson(res, { count: 0, cards: [], error: error.message }, 500), true;
        }
      }

      // GET — Observer Engine frontier over current short-window markets
      // Returns KnowabilityFrontier + TemporalBand + ConvergenceStateField snapshot
      if (url.pathname === '/api/trading/kalshi/observer-frontier' && req.method === 'GET') {
        const { createKalshiEngine } = require('../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../lib/kalshi-crypto-suggester');
        const { buildKalshiObserver, ConvergenceStateField } = require('../lib/observer-engine');
        const limit = q.limit ? Number(q.limit) : 50;

        let markets = [];
        const collector = deps.kalshiCollector;
        if (collector) {
          const latest = collector.getLatestMarkets?.();
          if (latest && latest.length > 0) markets = latest.filter(m => isShortWindowMarket(m, Date.now()));
        }
        if (markets.length === 0) {
          const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
          markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, Date.now()));
        }

        // Run IE first — results feed Observer Engine frontier classification
        const engine = createKalshiEngine();
        const ieResults = engine.solveAll(markets).map(({ result }) => result);

        const observer = buildKalshiObserver(markets.slice(0, limit), ieResults);
        const band = observer.emit_band();
        const csf = new ConvergenceStateField([band]);

        return sendJson(res, {
          generatedAt: new Date().toISOString(),
          marketCount: markets.length,
          frontier: observer.frontier.toJSON(),
          band: band.toJSON(),
          csf: csf.toJSON(),
          summary: {
            known:        observer.frontier.known.size,
            recallable:   observer.frontier.recallable.size,
            observable:   observer.frontier.observable.size,
            reachable:    observer.frontier.reachable.size,
            inferable:    observer.frontier.inferable.size,
            discoverable: observer.frontier.discoverable.size,
          },
        }, 200), true;
      }

      // GET — live market data (pass-through query: series_ticker, status, limit, event_ticker)
      if (url.pathname === '/api/trading/kalshi/live-markets' && req.method === 'GET') {
        const r = await kalshi.getMarkets(q);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/events-list' && req.method === 'GET') {
        const r = await kalshi.getEvents(q);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      // GET — order book for one market  (?ticker=...&depth=...)
      if (url.pathname === '/api/trading/kalshi/orderbook' && req.method === 'GET') {
        const r = await kalshi.getOrderbook(q.ticker, q.depth ? Number(q.depth) : 10);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      // GET — authenticated portfolio (balance / positions / orders / fills)
      if (url.pathname === '/api/trading/kalshi/balance' && req.method === 'GET') {
        const r = await kalshi.getBalance();
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/positions' && req.method === 'GET') {
        const r = await kalshi.getPositions(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/portfolio-orders' && req.method === 'GET') {
        const r = await kalshi.getOrders(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/fills' && req.method === 'GET') {
        const r = await kalshi.getFills(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      // POST — place order (dry-run / kill-switch gated inside placeOrder)
      if (url.pathname === '/api/trading/kalshi/order' && req.method === 'POST') {
        const body = await collectRequestBody(req);
        const o = body ? JSON.parse(body) : {};

        // Cash check before order (#434)
        try {
          const balance = await kalshi.getBalance();
          const availableCash = balance?.buying_power || balance?.cash || 0;
          const orderCost = (o.price || 0) * (o.quantity || 0);

          if (orderCost > 0 && availableCash < orderCost) {
            return sendJson(res, {
              error: 'INSUFFICIENT_FUNDS',
              message: `Insufficient cash: need ${(orderCost / 100).toFixed(2)}, have ${(availableCash / 100).toFixed(2)}`,
              required_cents: orderCost,
              available_cents: availableCash
            }, 402), true;
          }
        } catch (e) {
          console.warn('[trading] Cash check failed:', e.message);
        }

        const result = await kalshi.placeOrder(o);
        const httpStatus = result.mode === 'live' && result.status ? (result.status >= 200 && result.status < 300 ? 200 : result.status) : 200;
        return sendJson(res, result, httpStatus), true;
      }
      // POST — cancel order  { orderId }
      if (url.pathname === '/api/trading/kalshi/order/cancel' && req.method === 'POST') {
        const body = await collectRequestBody(req);
        const { orderId } = body ? JSON.parse(body) : {};
        if (!orderId) return sendJson(res, { error: 'orderId required' }, 400), true;
        const result = await kalshi.cancelOrder(orderId);
        const status = (result.error || result.errorMessage) ? 400 : (result.success === false ? 400 : 200);
        return sendJson(res, result, status), true;
      }

      // ── Paper trading ledger (dry-run position tracking) ───────────────────
      // POST — open a paper position (called after each dry-run "take")
      if (url.pathname === '/api/trading/kalshi/paper-trade' && req.method === 'POST') {
        const paperLedger = require('../lib/kalshi-paper-ledger');
        const body = await collectRequestBody(req);
        const o = body ? JSON.parse(body) : {};
        return sendJson(res, paperLedger.openPosition(o), 201), true;
      }
      // GET — poll open paper positions with live P&L + auto-exit signals
      if (url.pathname === '/api/trading/kalshi/paper-positions' && req.method === 'GET') {
        const paperLedger = require('../lib/kalshi-paper-ledger');
        const positions = await paperLedger.pollOpen();
        return sendJson(res, { count: positions.length, positions }, 200), true;
      }
      // POST — close a paper position  { id, exitTag?, exitPriceCents?, pnlPct? }
      if (url.pathname === '/api/trading/kalshi/paper-close' && req.method === 'POST') {
        const paperLedger = require('../lib/kalshi-paper-ledger');
        const body = await collectRequestBody(req);
        const { id, exitTag, exitPriceCents, pnlPct } = body ? JSON.parse(body) : {};
        if (!id) return sendJson(res, { error: 'id required' }, 400), true;

        const result = paperLedger.closePosition(id, { exitTag, exitPriceCents, pnlPct });

        // Σ₀ Phase A: Log trade performance metrics for strategy fitness aggregation
        if (result && result.position) {
          const pos = result.position;
          try {
            // Infer regime from exit tag
            const regime = exitTag === 'STOP-LOSS' ? 'MEAN' : exitTag === 'TAKE-PROFIT' ? 'TREND' : 'PIVOT';
            await logPerformance({
              strategy_id: pos.ticker || pos.market_ticker || 'unknown',
              regime,
              pnl: pnlPct ?? pos.pnlPct ?? 0,
              drawdown: pos.maxDrawdown ?? 0,
              stability: pos.stability ?? 0.5,
              position_id: id,
              market: pos.ticker || pos.market_ticker || 'unknown',
              is_live: false // paper trading
            });
          } catch (err) {
            console.error(`[trading] Failed to log performance for position ${id}:`, err.message);
          }
        }

        return sendJson(res, result, 200), true;
      }
      // GET /api/trading/kalshi/positions-deck?exitsOnly=true
      // Open positions as swipe cards: entry price, current bid, P&L, exit tag.
      // exitsOnly=true: only show positions marked for exit (STOP-LOSS/TAKE-PROFIT/CONVERGENCE)
      // Parallel market fetches so latency = slowest single market, not sum.
      if (url.pathname === '/api/trading/kalshi/positions-deck' && req.method === 'GET') {
        const exitsOnly = q.exitsOnly === 'true';
        const kalshi = require('../lib/kalshi-api');
      const posRes = await kalshi.getPositions({});
      const rawPositions = (posRes.data && posRes.data.market_positions) || [];

      // Kalshi v2 API returns position:0 (integer) even when position_fp is non-zero
      // (fractional contracts). Fall through to position_fp when the integer rounds to 0.
      const rawCount = p => {
        const pos = p.position;
        if (pos != null && pos !== 0) return parseFloat(pos);
        return parseFloat(p.position_fp ?? p.quantity_fp ?? 0);
      };

      const active = rawPositions.filter(p => {
        const n = rawCount(p);
        if (!Number.isFinite(n) || n === 0) return false;
        // Skip multi-game parlay positions — they can't be individually exited
        const t = p.ticker || p.market_ticker || '';
        if (t.includes('MVESPORTS') || t.includes('MVECROSS') || t.includes('MULTIGAME')) return false;
        return true;
      });

      // Σ₀ Fix: Add timeout protection to prevent hanging on slow Kalshi API responses
      const MARKET_FETCH_TIMEOUT_MS = 5000;
      const mkResults = await Promise.all(
        active.map(p => {
          const ticker = p.ticker || p.market_ticker;
          return new Promise(resolve => {
            const timeoutId = setTimeout(() => {
              console.warn(`[trading] Market fetch timeout for ${ticker} after ${MARKET_FETCH_TIMEOUT_MS}ms`);
              resolve(null);
            }, MARKET_FETCH_TIMEOUT_MS);

            kalshi.getMarket(ticker)
              .then(result => { clearTimeout(timeoutId); resolve(result); })
              .catch(err => { clearTimeout(timeoutId); resolve(null); });
          });
        })
      );

      const nowMs = Date.now();
      const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

      function entryCents(p, qty) {
        const expD = num(p.market_exposure_dollars);
        if (expD != null && qty > 0) return Math.round((Math.abs(expD) / qty) * 100);
        const exp = num(p.market_exposure);
        if (exp != null && qty > 0) return Math.round(Math.abs(exp) / qty);
        const avg = num(p.average_price_dollars) ?? num(p.avg_price_dollars);
        if (avg != null) return Math.round(avg * 100);
        return null;
      }

      // Kalshi taker fee: round_up(0.07 × C × P × (1-P)) in cents.
      // INX / NASDAQ100 markets use the 0.035 rate per fee schedule (Feb 5, 2026).
      function kalshiFee(contracts, priceCents, ticker = '') {
        const pc = Math.max(1, Math.min(99, priceCents));
        const P = pc / 100;
        const rate = (ticker.startsWith('INX') || ticker.startsWith('NASDAQ100')) ? 0.035 : 0.07;
        return Math.ceil(rate * contracts * P * (1 - P) * 100); // cents
      }

      const cards = [];
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        const m = mkResults[i] && mkResults[i].data && mkResults[i].data.market;
        const ticker = p.ticker || p.market_ticker;
        const count = rawCount(p);
        const heldSide = count > 0 ? 'yes' : 'no';
        const absCount = Math.abs(count);
        // Display qty: round fractional positions up to 1 so the card reads "1 contract"
        const qty = absCount < 1 ? 1 : Math.abs(Math.round(count));
        // Entry price: use raw fractional count so exposure/count gives the correct per-contract cost
        const entry = entryCents(p, absCount || 1) || 50;
        const bidCents = m ? (heldSide === 'yes'
          ? (m.yes_bid ?? Math.round((num(m.yes_bid_dollars) || 0) * 100))
          : (m.no_bid  ?? Math.round((num(m.no_bid_dollars)  || 0) * 100))) : entry;

        const pnlCents = bidCents - entry;
        const pnlPct   = Math.round((pnlCents / entry) * 100);
        const maxPayout = qty * 100; // $1 per contract in cents

        // Fee impact: exit fee you'd pay to sell now; entry fee already paid at open
        const exitFeeCents  = kalshiFee(qty, bidCents, ticker);
        const entryFeeCents = kalshiFee(qty, entry, ticker);
        const grossPnlCents = pnlCents * qty;
        const netPnlCents   = grossPnlCents - entryFeeCents - exitFeeCents;
        const costBasis     = entry * qty + entryFeeCents;
        const netPnlPct     = costBasis > 0 ? Math.round((netPnlCents / costBasis) * 100) : 0;

        const minsToClose = m && m.close_time
          ? Math.round((new Date(m.close_time).getTime() - nowMs) / 60000) : null;

        const yesCents = (m && m.yes_ask != null) ? m.yes_ask : null;
        const conviction = yesCents != null ? Math.min(99, Math.round(
          heldSide === 'yes' ? yesCents * 1.1 : (100 - yesCents) * 1.1
        )) : 50;

        const exitTag = pnlPct <= -30 ? 'STOP-LOSS'
          : pnlPct >= 40 ? 'TAKE-PROFIT'
          : (minsToClose !== null && minsToClose <= 30 && minsToClose >= 0) ? 'FLATTEN'
          : null;

        const pnlSign    = pnlPct >= 0 ? '+' : '';
        const netPnlSign = netPnlPct >= 0 ? '+' : '';
        const reason = `entry ${entry}¢ · bid ${bidCents}¢ · gross ${pnlSign}${pnlPct}% · fee −${exitFeeCents}¢ · net ${netPnlSign}${netPnlPct}%`;

        cards.push({
          kind: 'position', action: 'sell',
          ticker,
          title: (m && m.title) || ticker,
          yesLabel: (m && m.yes_sub_title) || 'YES',
          noLabel:  (m && m.no_sub_title)  || 'NO',
          favSide: heldSide,
          favLabel: heldSide === 'yes' ? ((m && m.yes_sub_title) || 'YES') : ((m && m.no_sub_title) || 'NO'),
          favAsk: bidCents,
          qty, entryCents: entry, currentBidCents: bidCents,
          pnlCents: grossPnlCents, pnlPct,
          netPnlCents, netPnlPct,
          exitFeeCents, entryFeeCents,
          maxPayoutCents: maxPayout,
          conviction, exitTag, minsToClose,
          close: (m && m.close_time) || '',
          reason, yesPct: yesCents, marketFound: m != null,
        });
      }

      // Σ₀ Phase A: Enrich cards with strategy fitness metrics (historical performance)
      for (const card of cards) {
        try {
          // Infer regime from market conditions: TREND if large P&L, MEAN if small, PIVOT if near close
          const regimeScore = Math.abs(card.pnlPct);
          const regime = card.minsToClose !== null && card.minsToClose <= 15 ? 'PIVOT'
            : regimeScore > 20 ? 'TREND'
            : 'MEAN';

          // Query historical performance for this strategy/regime pair
          const fitness = getStrategyFitness(card.ticker, regime);
          if (fitness && fitness.count > 0) {
            card.strategy_fitness = fitness;
          }
        } catch (err) {
          console.error(`[trading] Failed to load strategy fitness for ${card.ticker}:`, err.message);
        }
      }

      // Stop-loss first → flatten → take-profit → worst P&L first
      const urgency = t => t === 'STOP-LOSS' ? 0 : t === 'FLATTEN' ? 1 : t === 'TAKE-PROFIT' ? 2 : 3;
      cards.sort((a, b) => urgency(a.exitTag) - urgency(b.exitTag) || a.pnlPct - b.pnlPct);

      // Filter: show only positions marked for exit if exitsOnly is true
      const filtered = exitsOnly ? cards.filter(c => c.exitTag) : cards;

      return sendJson(res, {
        count: filtered.length,
        totalPositions: cards.length,
        exitsOnly,
        generatedAt: new Date().toISOString(),
        cards: filtered
      }, 200), true;
      }
    } catch (error) {
      return sendJson(res, { error: 'kalshi_api_error', details: error.message }, 502), true;
    }
  }

  // GET /api/trading/alpaca/account
  // Returns Alpaca paper trading account
  if (url.pathname === '/api/trading/alpaca/account' && req.method === 'GET') {
    try {
      const account = await bridge.getAlpacaAccount();
      sendJson(res, { account }, 200);
    } catch (error) {
      sendJson(res, { error: 'Alpaca not available', details: error.message }, 503);
    }
    return true;
  }

  // ── AI Trader Integration Routes ──────────────────────────────────────────
  // Proxies to the Independent AI Trader's REST API (port 5555, see
  // C:\Independant AI Trader\src\ai_trader_api.py). That service only
  // exposes /health, /api/status, /api/watchlist, /api/zones, /api/signals,
  // /api/positions, /api/alerts, and /api/control/{pause,resume,close-position}
  // — routes below map onto those. Endpoints with no equivalent there
  // (signal generation, trade history, metrics) return 501.

  // GET /api/trading/ai-trader/health
  // Check AI trader microservice health
  if (url.pathname === '/api/trading/ai-trader/health' && req.method === 'GET') {
    try {
      const result = await callAITrader('/health');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, {
        error: 'AI trader service unavailable',
        details: error.message,
        endpoint: `http://${AI_TRADER_HOST}:${AI_TRADER_PORT}`
      }, 503);
    }
    return true;
  }

  // GET /api/trading/ai-trader/signals
  // Get recent AI-generated trading signals
  if (url.pathname === '/api/trading/ai-trader/signals' && req.method === 'GET') {
    try {
      const limit = url.searchParams.get('limit') || 10;
      const result = await callAITrader(`/api/signals?limit=${limit}`);
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch signals', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/signals/generate
  // Trigger the LOCAL market scanner on demand (the honest "scan now" mapping —
  // the external AI-trader microservice has no on-demand endpoint). Non-blocking:
  // the scan (~90s) runs in the background and records any signals to the agent
  // log, which the UI polls. No more 501 dead affordance (#1229).
  if (url.pathname === '/api/trading/ai-trader/signals/generate' && req.method === 'POST') {
    if (!traderAgent) {
      return sendJson(res, { status: 'error', error: 'TraderAgent not initialized' }, 503);
    }
    traderAgent.scanMarket().then((scan) => {
      const signals = Array.isArray(scan && scan.signals) ? scan.signals : [];
      const logs = signals.filter((s) => s && s.symbol).map((s) => ({
        id: `scan_${scan.timestamp}_${s.symbol}`,
        agent: s.agent || 'scanner',
        action: s.direction || s.action || s.status || 'signal',
        symbol: s.symbol,
        confidence: s.confidence,
        timestamp: scan.timestamp,
      }));
      if (logs.length) tradingMemory.recordNewSignals({ logs }).catch(() => {});
    }).catch((e) => console.error('[Trading] ai-trader signals/generate scan failed:', e.message));
    sendJson(res, { status: 'scan_triggered', message: 'Local market scan started; new signals will appear in the agent log shortly.' }, 202);
    return true;
  }

  // GET /api/trading/ai-trader/portfolio
  // Get current open positions from AI trader
  if (url.pathname === '/api/trading/ai-trader/portfolio' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/positions');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Portfolio fetch failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/trades
  // Real local append-only trade history (trading-history-logger), consistent
  // with the Kalshi history logger — not the absent external service (#1229).
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'GET') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const trades = tradeHistory.getTradeHistory({ limit: limit > 0 ? limit : 50 });
      sendJson(res, { trades }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read trade history', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/trades
  // Append a trade to the local trade history.
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const trade = body ? JSON.parse(body) : {};
      if (!trade || !trade.entry_symbol) {
        return sendJson(res, { error: 'entry_symbol is required' }, 400);
      }
      await tradeHistory.logTrade(trade);
      sendJson(res, { recorded: true, trade }, 201);
    } catch (error) {
      sendJson(res, { error: 'Failed to log trade', details: error.message }, 400);
    }
    return true;
  }

  // GET /api/trading/ai-trader/metrics
  // Real metrics (win-rate, P&L, count) derived from the local trade history.
  if (url.pathname === '/api/trading/ai-trader/metrics' && req.method === 'GET') {
    try {
      sendJson(res, tradeHistory.getTradeStats(), 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to compute metrics', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/scanner/start
  // Maps to the AI trader's /api/control/resume (clears its paused flag)
  if (url.pathname === '/api/trading/ai-trader/scanner/start' && req.method === 'POST') {
    try {
      const result = await callAITrader('/api/control/resume', 'POST');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner start failed', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/scanner/stop
  // Maps to the AI trader's /api/control/pause (sets its paused flag)
  if (url.pathname === '/api/trading/ai-trader/scanner/stop' && req.method === 'POST') {
    try {
      const result = await callAITrader('/api/control/pause', 'POST');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner stop failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/scanner/status
  // Maps to the AI trader's /api/status, which includes a `paused` flag
  if (url.pathname === '/api/trading/ai-trader/scanner/status' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/status');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner status check failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/status
  // Get complete AI trader system status
  if (url.pathname === '/api/trading/ai-trader/status' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/status');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Status check failed', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/ai-trader/watchlist
  // Get AI trader's current watchlist
  if (url.pathname === '/api/trading/ai-trader/watchlist' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/watchlist');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Watchlist fetch failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/zones
  // Get AI trader's detected market zones
  if (url.pathname === '/api/trading/ai-trader/zones' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/zones');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Zones fetch failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/memory/recent?limit=20&kind=order|signal
  // Trading Phase 2 (#323): recent orders/signals persisted into CSF memory
  // queryable by dream-chat and other agents. Newest first.
  if (url.pathname === '/api/trading/memory/recent' && req.method === 'GET') {
    try {
      const limit = Number(url.searchParams.get('limit')) || 20;
      const rawKind = url.searchParams.get('kind');
      const kind = rawKind === 'order' || rawKind === 'signal' ? rawKind : undefined;
      const records = await tradingMemory.queryRecent({ limit, kind });
      sendJson(res, { records }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to query trading memory', details: error.message, records: [] }, 500);
    }
    return true;
  }

  // GET /api/trading/csf-records?limit=50
  // Same CSF registry as /memory/recent, records + count, no kind filter.
  if (url.pathname === '/api/trading/csf-records' && req.method === 'GET') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const records = queryRecentTradingRecords(limit);
      sendJson(res, { records, count: records.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'CSF query failed', details: error.message }, 500);
    }
    return true;
  }

  // ── Trading Phase 3: News CSF integration (#324) ─────────────────────────

  // GET /api/trading/news/recent?limit=50&ticker=SPY&sentiment=high
  // Recent news items persisted as CSF Entity records, newest first.
  if (url.pathname === '/api/trading/news/recent' && req.method === 'GET') {
    try {
      const limit = Number(url.searchParams.get('limit')) || 50;
      const ticker = url.searchParams.get('ticker') || '';
      const sentiment = url.searchParams.get('sentiment') || '';
      const records = tradingNews.queryRecentNews({ limit, ticker, sentiment });
      sendJson(res, { records, count: records.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'News query failed', details: error.message, records: [] }, 500);
    }
    return true;
  }

  // POST /api/trading/news/record
  // Explicitly record a news item into CSF (used by the UI or external ingestion).
  if (url.pathname === '/api/trading/news/record' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const item = body ? JSON.parse(body) : {};
      await tradingNews.recordNewsItem(item);
      sendJson(res, { ok: true }, 201);
    } catch (error) {
      sendJson(res, { error: 'News record failed', details: error.message }, 400);
    }
    return true;
  }

  // POST /api/trading/news/link-trade
  // Record a news→trade influence relation when a trade follows a news item
  // for the same ticker within the configured window.
  if (url.pathname === '/api/trading/news/link-trade' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const { newsId, orderId, ticker, windowMinutes } = body ? JSON.parse(body) : {};
      if (!newsId || !orderId) {
        sendJson(res, { error: 'newsId and orderId required' }, 400);
        return true;
      }
      await tradingNews.linkNewsTrade({ newsId, orderId, ticker, windowMinutes });
      sendJson(res, { ok: true, relation: `${newsId} → ${orderId}` }, 201);
    } catch (error) {
      sendJson(res, { error: 'Link failed', details: error.message }, 400);
    }
    return true;
  }

  // GET /api/trading/kalshi/collector-status
  // Get tight-band collector status and latest snapshot
  if (url.pathname === '/api/trading/kalshi/collector-status' && req.method === 'GET') {
    try {
      const collector = deps.kalshiCollector;
      const latest = collector ? collector.getLatest() : null;
      const collectorStatus = collector?.getStatus?.() || null;
      sendJson(res, {
        running: !!collector,
        backoff: collectorStatus?.backoff || false,
        resumeAt: collectorStatus?.resumeAt || null,
        lastSnapshot: latest ? {
          generatedAt: latest.generatedAt,
          marketCount: latest.markets?.length || 0,
          exitCount: latest.exitCount || 0,
          markets: latest.markets?.slice(0, 5),
        } : null,
      }, 200);
    } catch (error) {
      sendJson(res, { error: 'Collector status check failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/settings
  // Get API key status (shows which are configured, no secrets exposed)
  // IBKR is always true — configured via Claude Code MCP (read-only market data)
  if (url.pathname === '/api/trading/settings' && req.method === 'GET') {
    const providers = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      ibkr: true, // Always configured via Claude Code MCP
      alpaca: !!process.env.ALPACA_API_KEY,
      kalshi: !!process.env.KALSHI_API_KEY,
    };
    sendJson(res, {
      configured: providers,
      mcp: {
        ibkr: 'Claude Code MCP: Live quotes, positions, orderbook, account risk (read-only)',
        alpaca: 'Alpaca MCP Server: Stocks, options, crypto, portfolio management'
      }
    }, 200);
    return true;
  }

  // POST /api/trading/settings
  // Update API keys (only in memory for this session, recommend setting via .env)
  if (url.pathname === '/api/trading/settings' && req.method === 'POST') {
    try {
      const body = await deps.collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const updated = [];

      if (payload.anthropic) {
        process.env.ANTHROPIC_API_KEY = payload.anthropic;
        updated.push('anthropic');
      }
      if (payload.openai) {
        process.env.OPENAI_API_KEY = payload.openai;
        updated.push('openai');
      }
      if (payload.gemini) {
        process.env.GEMINI_API_KEY = payload.gemini;
        updated.push('gemini');
      }
      if (payload.alpaca) {
        process.env.ALPACA_API_KEY = payload.alpaca;
        updated.push('alpaca');
      }
      if (payload.kalshi) {
        process.env.KALSHI_API_KEY = payload.kalshi;
        updated.push('kalshi');
      }
      if (payload.alpaca && payload.alpaca.key && payload.alpaca.secret) {
        process.env.ALPACA_API_KEY = payload.alpaca.key;
        process.env.ALPACA_SECRET_KEY = payload.alpaca.secret;
        updated.push('alpaca');
      }
      if (payload.ibkr_account && payload.ibkr_password) {
        process.env.IBKR_ACCOUNT_ID = payload.ibkr_account;
        process.env.IBKR_PASSWORD = payload.ibkr_password;
        updated.push('ibkr');
      }

      sendJson(res, {
        ok: true,
        updated,
        message: updated.length > 0
          ? `Updated ${updated.join(', ')} (session only; add to .env to persist)`
          : 'No keys updated'
      }, 200);
    } catch (error) {
      sendJson(res, { error: 'Settings update failed', details: error.message }, 400);
    }
    return true;
  }

  // ── TradingTesseract ─────────────────────────────────────────────────────

  // POST /api/trading/evaluate-asset
  // Body: { asset: 'AAPL', zones_data?, market_status?, agent_log? }
  // Returns: { asset, cube, confidence, action, evaluated_at }
  if (url.pathname === '/api/trading/evaluate-asset' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const params = body ? JSON.parse(body) : {};
        if (!params.asset) {
          sendJson(res, { error: 'asset is required' }, 400);
          return;
        }
        if (!traderAgent) {
          sendJson(res, { error: 'TraderAgent not initialised' }, 503);
          return;
        }
        // Fetch supporting data in parallel if not supplied
        const [zonesResult, marketResult, agentLogResult] = await Promise.all([
          params.zones_data   ? Promise.resolve({ zones: params.zones_data })
                              : traderAgent._callPython('scan_market', { watchlist: [params.asset] }).catch(() => ({})),
          params.market_status ? Promise.resolve(params.market_status)
                               : traderAgent._callPython('get_market_status', {}).catch(() => ({})),
          traderAgent._callPython('scan_market', {}).catch(() => ({ logs: [] })).catch(() => ({ logs: [] })),
        ]);
        const evaluateArgs = {
          asset:         params.asset,
          zones_data:    zonesResult.zones || zonesResult || {},
          market_status: marketResult,
          agent_log:     (agentLogResult.signals || agentLogResult.logs || []),
        };
        const result = await traderAgent._callPython('evaluate_asset', evaluateArgs);

        // Persist to CSF memory as a TRACE record
        try {
          const { recordSignal } = require('../lib/trading-memory');
          await recordSignal({
            id:        `tesseract-${result.asset}-${Date.now()}`,
            symbol:    result.asset,
            type:      'tesseract_evaluation',
            action:    result.action,
            confidence: result.confidence,
            cube:      result.cube,
            timestamp: result.evaluated_at,
          });
        } catch (_) { /* non-fatal */ }

        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/trading/evaluate-watchlist
  // Body: { watchlist?: string[], zones_data?, market_status?, agent_log? }
  // Returns: { evaluations: [...], count, evaluated_at }
  if (url.pathname === '/api/trading/evaluate-watchlist' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const params = body ? JSON.parse(body) : {};
        const DEFAULT_WL = ['SPY', 'AAPL', 'TSLA', 'NVDA', 'MSFT'];
        const watchlist = params.watchlist || DEFAULT_WL;
        const zones    = params.zones_data    || {};
        const market   = params.market_status || {};
        const agentLog = params.agent_log     || [];

        // Pure-JS TradingTesseract (mirrors trading_tesseract.py exactly)
        function classifyTime(z, m) {
          if (!m.market_open) return 'eod';
          const ts = z.timestamp || z.updated_at;
          if (ts) {
            const ageS = (Date.now() - new Date(ts).getTime()) / 1000;
            if (ageS < 60)   return 'realtime';
            if (ageS < 3600) return 'intraday';
            return 'session';
          }
          return 'intraday';
        }
        function classifyMarket(m) {
          const vix = (m.vix_regime || '').toUpperCase();
          if (vix === 'HIGH' || vix === 'EXTREME') return 'volatile';
          const spy = parseFloat(m.spy_day_change_pct || 0);
          if (spy >  0.8) return 'bullish';
          if (spy < -0.8) return 'bearish';
          if (vix === 'CALM') return 'calm';
          return 'neutral';
        }
        function classifySignal(asset, z, log) {
          for (let i = log.length - 1; i >= Math.max(0, log.length - 50); i--) {
            const e = log[i];
            const sym = (e.symbol || e.asset || e.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            const s = (e.signal_strength || e.strength || '').toLowerCase();
            if (['strong','moderate','weak','invalid'].includes(s)) return s;
            const sc = parseFloat(e.score || e.confidence || 0);
            if (sc >= 0.75) return 'strong';
            if (sc >= 0.45) return 'moderate';
            if (sc > 0)     return 'weak';
          }
          const az = z[asset] || {};
          const top = parseFloat(az.top || az.resistance || 0);
          const bot = parseFloat(az.bottom || az.support || 0);
          const mid = parseFloat(az.mid || az.entry_price || 0);
          if (!top || !bot || !mid) return 'invalid';
          const spread = (top - bot) / mid;
          if (spread < 0.02) return 'strong';
          if (spread < 0.05) return 'moderate';
          return 'weak';
        }
        function classifyLayer(log, asset) {
          for (let i = log.length - 1; i >= Math.max(0, log.length - 50); i--) {
            const e = log[i];
            const sym = (e.symbol || e.asset || e.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            const a = (e.agent || e.layer || '').toLowerCase();
            if (['scanner','riley','mft','risk','claude','execution'].includes(a)) return a;
            if (a.includes('claude'))  return 'claude';
            if (a.includes('mft'))     return 'mft';
            if (a.includes('riley'))   return 'riley';
            if (a.includes('risk'))    return 'risk';
            if (a.includes('execut'))  return 'execution';
          }
          return 'scanner';
        }
        function classifyState(asset, m) {
          for (const p of (m.positions || [])) {
            const sym = (p.symbol || p.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            return parseFloat(p.qty || p.quantity || 0) !== 0 ? 'in_trade' : 'closed';
          }
          return 'watching';
        }
        const SIG_SC  = {strong:1.0, moderate:0.6, weak:0.3, invalid:0.0};
        const MKT_SC  = {bullish:1.0, neutral:0.5, calm:0.5, volatile:0.35, bearish:0.1};
        const ST_SC   = {watching:0.5, active:0.8, in_trade:0.9, closed:0.0, rejected:0.0};
        const LYR_SC  = {claude:1.0, mft:0.85, riley:0.75, scanner:0.6, risk:0.5, execution:0.4};
        const TIME_SC = {realtime:1.0, intraday:0.8, session:0.6, eod:0.4};
        function confidence(cube) {
          return Math.round(10000 * (
            0.35 * (SIG_SC[cube.signal]      || 0) +
            0.30 * (MKT_SC[cube.market]      || 0.5) +
            0.15 * (ST_SC[cube.asset_state]  || 0) +
            0.10 * (LYR_SC[cube.layer]       || 0.5) +
            0.10 * (TIME_SC[cube.time]       || 0.5)
          )) / 10000;
        }
        function deriveAction(conf, cube) {
          if (cube.signal === 'invalid')                                       return 'skip';
          if (['closed','rejected'].includes(cube.asset_state))               return 'skip';
          if (cube.market === 'volatile' && conf < 0.55)                      return 'hold';
          if (conf >= 0.72 && ['bullish','neutral','calm'].includes(cube.market)) return 'buy';
          if (conf >= 0.55)                                                    return 'watch';
          if (cube.market === 'bearish' && ['weak','invalid'].includes(cube.signal)) return 'skip';
          return 'hold';
        }

        const now = new Date().toISOString();
        const evaluations = watchlist.map(asset => {
          const cube = {
            time:        classifyTime(zones, market),
            market:      classifyMarket(market),
            signal:      classifySignal(asset, zones, agentLog),
            layer:       classifyLayer(agentLog, asset),
            asset_state: classifyState(asset, market),
          };
          const conf = confidence(cube);
          return { asset: asset.toUpperCase(), cube, confidence: conf, action: deriveAction(conf, cube), evaluated_at: now };
        }).sort((a, b) => b.confidence - a.confidence);

        sendJson(res, { evaluations, count: evaluations.length, evaluated_at: now });
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }


  // ── Price Feed (Phase 5) ──────────────────────────────────────────────────

  // GET /api/trading/price-feed?symbol=AAPL&range=1D
  // Returns: { symbol, range, ticks, source, current_price, open_price, generated_at }
  if (url.pathname === '/api/trading/price-feed' && req.method === 'GET') {
    const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase();
    const range  = url.searchParams.get('range') || '1D';
    try {
      const data = await getPriceFeed().getTicks(symbol, range);
      sendJson(res, data);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // GET /api/trading/price-feed/watchlist?range=1D
  // Returns: [{ symbol, range, ticks, source, current_price, ... }, ...]
  if (url.pathname === '/api/trading/price-feed/watchlist' && req.method === 'GET') {
    const range     = url.searchParams.get('range') || '1D';
    const DEFAULT_WL = ['SPY', 'AAPL', 'TSLA', 'NVDA', 'MSFT'];
    const watchlist = url.searchParams.get('symbols')
      ? url.searchParams.get('symbols').split(',').map(s => s.trim().toUpperCase())
      : DEFAULT_WL;
    try {
      const results = await getPriceFeed().getWatchlistTicks(watchlist, range);
      sendJson(res, results);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // ── Crypto Collector Routes ──────────────────────────────────────────────────
  // Real-time crypto pricing and news from Kalshi markets + CoinGecko

  // GET /api/trading/crypto/prices
  // Returns latest crypto prices (BTC, ETH, SOL, XRP, DOGE) from Kalshi prediction markets
  if (url.pathname === '/api/trading/crypto/prices' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const prices = cryptoCollector.getLatestPrices();
      sendJson(res, { timestamp: new Date().toISOString(), prices }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch crypto prices', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/kalshi/observer-status
  // Reports live crypto_live_trader.py observer health and today's snapshot count
  if (url.pathname === '/api/trading/kalshi/observer-status' && req.method === 'GET') {
    try {
      const { fs: dfs, path: dpath, repoRoot: root } = deps;
      const obs = deps.cryptoObserver;
      const today = new Date().toISOString().slice(0, 10);
      const snapshotFile = dpath.join(root, 'data', `crypto-tight-band-${today}.jsonl`);
      let snapshotCount = 0;
      let lastSnapshot = null;
      if (dfs.existsSync(snapshotFile)) {
        const lines = dfs.readFileSync(snapshotFile, 'utf8').split('\n').filter(Boolean);
        snapshotCount = lines.length;
        try { lastSnapshot = JSON.parse(lines[lines.length - 1]).timestamp || null; } catch {}
      }
      const alive = obs ? obs.process.exitCode === null : false;
      sendJson(res, {
        alive,
        pid: obs?.pid || null,
        startedAt: obs?.startedAt || null,
        today,
        snapshotCount,
        lastSnapshot,
        snapshotFile: snapshotFile.replace(root, ''),
      });
    } catch (error) {
      sendJson(res, { error: 'Observer status check failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/crypto/news
  // Returns latest crypto news from CoinGecko trending endpoint
  if (url.pathname === '/api/trading/crypto/news' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const news = cryptoCollector.getLatestNews();
      sendJson(res, { timestamp: new Date().toISOString(), news }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch crypto news', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/crypto/prices/historical?limit=100
  // Returns historical crypto price snapshots (JSONL-based time series)
  if (url.pathname === '/api/trading/crypto/prices/historical' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : 100;
      const prices = cryptoCollector.getHistoricalPrices(limit);
      sendJson(res, { timestamp: new Date().toISOString(), count: prices.length, prices }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch historical prices', details: error.message }, 500);
    }
    return true;
  }

  // ── Trade History Persistence (P3) ──────────────────────────────────
  // GET /api/trading/history/trades?symbol=BTCUSD&limit=20
  // Returns completed trades with entry, exit, and P&L
  if (url.pathname === '/api/trading/history/trades' && req.method === 'GET') {
    try {
      const tradingHistory = require('../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const trades = tradingHistory.getTradeHistory({ symbol, limit });
      sendJson(res, { trades, count: trades.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch trade history', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/history/signals?symbol=BTCUSD&limit=20&min_confidence=0.7
  // Returns generated trading signals with confidence scores
  if (url.pathname === '/api/trading/history/signals' && req.method === 'GET') {
    try {
      const tradingHistory = require('../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const minConfidence = parseFloat(url.searchParams.get('min_confidence') || '0');
      const signals = tradingHistory.getSignalHistory({ symbol, limit, min_confidence: minConfidence });
      sendJson(res, { signals, count: signals.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch signal history', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/history/stats?symbol=BTCUSD
  // Returns trade statistics (win rate, average P&L, etc.)
  if (url.pathname === '/api/trading/history/stats' && req.method === 'GET') {
    try {
      const tradingHistory = require('../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const stats = tradingHistory.getTradeStats({ symbol });
      sendJson(res, { timestamp: new Date().toISOString(), stats }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to compute trade statistics', details: error.message }, 500);
    }
    return true;
  }

  return false;
};


