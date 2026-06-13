/**
 * Trading API Routes
 * Serves market data, AI recommendations, and broker integration
 * Integrates with independent AI trader microservice
 */

const http = require('http');
const TradingAPIBridge = require('../lib/trading-api-bridge');
const tradingMemory = require('../lib/trading-memory');
const tradingStore = require('../lib/trading-store');
const { recordOrder, recordSignal, queryRecentTradingRecords } = tradingMemory;

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
// feature. In particular, trading memory (orders, agent-log/signals, and
// CSF-backed recent-memory queries — see #323) is served entirely from
// local LanternOS data (data/lantern-garage/trading/ and data/csf_memory/)
// by the routes below and does NOT depend on this proxy or on port 5050.
// If the external service isn't running, these routes simply 502 — the
// rest of LanternOS keeps working.
const DASHBOARD_PROXY_ROUTES = {
  '/api/trading/dashboard/positions': '/api/positions',
  '/api/trading/dashboard/market-status': '/api/market-status',
  '/api/trading/dashboard/zones': '/api/zones',
  '/api/trading/dashboard/watchlist-prices': '/api/watchlist-prices',
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
  // GET /api/trading/dashboard/{positions,market-status,zones,watchlist-prices,news-feed}
  if (req.method === 'GET' && DASHBOARD_PROXY_ROUTES[url.pathname]) {
    try {
      const proxyPath = DASHBOARD_PROXY_ROUTES[url.pathname];
      const data = await callDashboard(proxyPath);
      // CSF memory wiring: write orders and agent-log to CSF on state change
      if (proxyPath === '/api/orders' && Array.isArray(data?.orders || data)) {
        const orders = data.orders || data;
        for (const o of orders) { recordOrder(o).catch(() => {}); }
      }
      if (proxyPath === '/api/agent-log' && Array.isArray(data?.logs || data)) {
        const logs = data.logs || data;
        for (const s of logs) { recordSignal(s).catch(() => {}); }
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
  // (apps/lantern-garage/lib/csf-memory-writer.js, pure JS — no Python
  // process), queryable by dream-chat and other agents. Newest first.
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
  // Same CSF registry as /api/trading/memory/recent, in the shape used by
  // the earlier #323 implementation (records + count, no kind filter).
  // queryRecentTradingRecords() is a sync compat wrapper around
  // csf-memory-writer's queryRecent() — see lib/trading-memory.js.
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

  return false;
};
