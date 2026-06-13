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
      const scan = await traderAgent.scanMarket();
      if (!scan.error) {
        const signals = Array.isArray(scan.signals) ? scan.signals : [];
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
      sendJson(res, { zones: scan.zones || {} }, 200);
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
  // Recent orders from Alpaca (via local cache or CSF)
  if (url.pathname === '/api/trading/orders' && req.method === 'GET') {
    try {
      // Query recent order records from CSF memory
      const records = queryRecentTradingRecords(50, 'order');
      const orders = records.map(r => ({
        id: r.content.order_id || '',
        symbol: r.content.symbol || '',
        side: r.content.side || '',
        qty: r.content.qty || 0,
        type: (r.content.raw && r.content.raw.order_type) || 'market',
        status: r.content.status || 'unknown',
        filled_at: r.content.filled_at || '',
        filled_avg: r.content.price || 0
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
  // No equivalent on the AI trader's REST API — signal generation runs on
  // its own background scanner, not on demand via HTTP.
  if (url.pathname === '/api/trading/ai-trader/signals/generate' && req.method === 'POST') {
    sendJson(res, { error: 'Not implemented: AI trader has no on-demand signal generation endpoint' }, 501);
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
  // No equivalent on the AI trader's REST API — it does not expose trade
  // history over HTTP.
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'GET') {
    sendJson(res, { error: 'Not implemented: AI trader has no trade history endpoint' }, 501);
    return true;
  }

  // POST /api/trading/ai-trader/trades
  // No equivalent on the AI trader's REST API.
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'POST') {
    sendJson(res, { error: 'Not implemented: AI trader has no trade logging endpoint' }, 501);
    return true;
  }

  // GET /api/trading/ai-trader/metrics
  // No equivalent on the AI trader's REST API.
  if (url.pathname === '/api/trading/ai-trader/metrics' && req.method === 'GET') {
    sendJson(res, { error: 'Not implemented: AI trader has no metrics endpoint' }, 501);
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

  return false;
};


