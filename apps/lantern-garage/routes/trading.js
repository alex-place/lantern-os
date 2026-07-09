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
const { readJsonCached } = require('../lib/jsonl-cache');
const tradingNews = require('../lib/trading-news');
const { getEffectiveUserId } = require("../lib/session-identity"); // per-user IBKR (ADR-0022)
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

// ── Autonomous market scan loop (Σ₀ Observe stage) ───────────────────────────
// Scan the watchlist every ~minute regardless of page activity, so signals,
// entry/exit instructions, and (when enabled) auto-execution stay live even with
// nobody watching the page. Self-RESCHEDULING — the next scan is queued only
// after the previous finishes, so a slow 45-60s scan never overlaps itself.
// The shared cache means page polls in the same minute reuse this scan rather
// than triggering a second one. Kill-switch: TRADER_AUTOSCAN=0.
const AUTOSCAN_MS = parseInt(process.env.TRADER_AUTOSCAN_MS || '60000');
// Off-hours the only thing scanning is crypto (stocks are market-gated in the
// engine) and it moves slowly — so back the cadence off to save API spend. The
// engine still uses the authoritative Alpaca clock to decide what to trade; this
// is cadence only. Kill-switch: set TRADER_AUTOSCAN_CLOSED_MS=60000 to disable.
const AUTOSCAN_CLOSED_MS = parseInt(process.env.TRADER_AUTOSCAN_CLOSED_MS || '300000'); // 5 min
function _isUsMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();                       // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;              // 09:30 (570) .. 16:00 (960) ET
}
const { runAutoTrade } = require('../lib/auto-trader');   // autonomous Act-stage executor
const _autoBridge = new TradingAPIBridge();               // shared: keeps the LST cache warm across scans
let _autoscanStopped = false;
// Overnight (market-closed) scanning is OFF by default — off-hours the only thing
// to scan is crypto, and the user mostly wants it idle overnight. Flip on via the
// 🌙 toggle for after-hours crypto testing; it auto-resets at the next market open
// so a forgotten toggle can't quietly burn tokens later. (#1714)
let _scanWhenClosed = process.env.TRADER_SCAN_CLOSED === '1';
async function _autoscanTick() {
  if (_autoscanStopped || !traderAgent) return;
  const marketHours = _isUsMarketHours();
  if (marketHours && _scanWhenClosed) _scanWhenClosed = false;      // auto-reset at open
  // Off-hours with overnight scanning off → skip the scan entirely: no Python
  // spawn, no model call, zero tokens. The price collectors keep polling (free).
  if (marketHours || _scanWhenClosed) {
    try {
      traderAgent.cache && (traderAgent.cache['market_scan'] = null); // force fresh each minute
      const scan = await traderAgent.scanMarket();
      const n = Array.isArray(scan && scan.signals) ? scan.signals.length : 0;
      if (n) console.log(`[Trading] autoscan — ${n} signal(s)`);
      // Act stage: autonomously execute the ENTER verdicts on the owner's IBKR
      // account. No-op unless TRADER_AUTO_EXECUTE=1 (separate from manual arming);
      // every order still passes the hard guard. Stocks only during market hours.
      if (marketHours) {
        const at = await runAutoTrade(scan, { bridge: _autoBridge, userId: process.env.TRADER_AUTO_USER || 'local-owner' });
        for (const e of (at.executed || [])) {
          console.log(`[AutoTrader] ${e.action} ${e.symbol} x${e.qty} → ${e.result && e.result.status} (p_win=${e.p_win})`);
        }
        if (at.enabled && !(at.executed || []).length && at.reason) console.log(`[AutoTrader] no action — ${at.reason}`);
      }
    } catch (e) {
      console.error('[Trading] autoscan failed:', e.message);
    }
  }
  if (!_autoscanStopped) setTimeout(_autoscanTick, marketHours ? AUTOSCAN_MS : AUTOSCAN_CLOSED_MS);
}
if (traderAgent && process.env.TRADER_AUTOSCAN !== '0') {
  setTimeout(_autoscanTick, 5000); // first scan shortly after boot
  console.log(`[Trading] autonomous scan loop started (every ${AUTOSCAN_MS}ms)`);
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
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 8e6) { req.destroy(); reject(new Error('trader service response too large')); }
      });
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
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 8e6) { req.destroy(); reject(new Error('trader service response too large')); }
      });
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

// ── Endpoint-group modules (split from this file; see routes/trading/) ─────
const marketRoutes = require('./trading/market');
const ordersRoutes = require('./trading/orders');
const watchlistRoutes = require('./trading/watchlist');
const dashboardRoutes = require('./trading/dashboard');
const ibkrRoutes = require('./trading/ibkr');
const kalshiRoutes = require('./trading/kalshi');
const aiTraderRoutes = require('./trading/ai-trader');
const newsRoutes = require('./trading/news');
const miscRoutes = require('./trading/misc');


module.exports = async function tradingRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const bridge = new TradingAPIBridge();

  // Shared context handed to every endpoint-group module. Over-inclusive by
  // design (unused keys are harmless) so branch bodies keep resolving names.
  const ctx = {
    req, res, url, deps, sendJson, collectRequestBody, bridge,
    traderAgent, getPriceFeed, callAITrader, callDashboard,
    tradingMemory, tradingStore, tradingNews, readJsonCached, getEffectiveUserId,
    recordOrder, recordSignal, queryRecentTradingRecords,
    getStrategyFitness, logPerformance, tradeHistory,
    DASHBOARD_PROXY_ROUTES, DIRECT_DASHBOARD_PROXY_PATHS,
    AI_TRADER_HOST, AI_TRADER_PORT,
  };


  // GET/POST /api/trading/overnight-scan — read or flip overnight (market-closed)
  // crypto scanning. ?set=on|off|toggle changes it; GET with no param just reads.
  // Off = no off-hours model calls (0 tokens); auto-resets to off at market open. (#1714)
  if (url.pathname === '/api/trading/overnight-scan') {
    const set = (url.searchParams.get('set') || '').toLowerCase();
    if (set === 'on') _scanWhenClosed = true;
    else if (set === 'off') _scanWhenClosed = false;
    else if (set === 'toggle') _scanWhenClosed = !_scanWhenClosed;
    sendJson(res, { enabled: _scanWhenClosed, marketHours: _isUsMarketHours() }, 200);
    return true;
  }

  // ── Delegate to endpoint-group modules (original first-match order preserved) ─
  if (await marketRoutes(req, res, url, ctx)) return true;
  if (await ordersRoutes(req, res, url, ctx)) return true;
  if (await watchlistRoutes(req, res, url, ctx)) return true;
  if (await dashboardRoutes(req, res, url, ctx)) return true;
  if (await ibkrRoutes(req, res, url, ctx)) return true;
  if (await kalshiRoutes(req, res, url, ctx)) return true;
  if (await aiTraderRoutes(req, res, url, ctx)) return true;
  if (await newsRoutes(req, res, url, ctx)) return true;
  if (await miscRoutes(req, res, url, ctx)) return true;

  return false;
};


