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
const { internalUserId } = require("../lib/request-auth");
// Chat tools reach these routes via a session-less in-process loopback GET, so the
// session resolver alone would drop the requesting user (and with it their per-user
// IBKR connection). Fall back to the operator-trusted forwarded id (x-keystone-user).
const effectiveUserId = (req) => getEffectiveUserId(req) || internalUserId(req) || null;
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
// Pre-market (04:00–09:30) and after-hours (16:00–20:00) ET, Mon–Fri — the extended
// session where IBKR accepts LMT + outsideRTH orders.
function _isUsExtendedHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return (mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200); // 04:00–09:30 | 16:00–20:00
}
const { runAutoTrade } = require('../lib/auto-trader');   // autonomous Act-stage executor
const _autoBridge = new TradingAPIBridge();               // shared: keeps the LST cache warm across scans
let _autoscanStopped = false;
// Extended-hours (pre-market / after-hours) trading — OFF by default. When on (⏰ toggle
// or TRADER_EXTENDED_HOURS=1) the trader also scans + acts during the extended session,
// placing marketable-limit + outsideRTH orders (regular hours use market orders as before).
let _extendedTrading = process.env.TRADER_EXTENDED_HOURS === '1';
async function _autoscanTick() {
  if (_autoscanStopped || !traderAgent) return;
  const marketHours = _isUsMarketHours();
  const extNow = _isUsExtendedHours() && _extendedTrading;   // only pre/post when the toggle is on
  // Regular hours always run; extended hours only when the toggle is on. Otherwise idle
  // (no Python spawn / model call — the price collectors keep polling for free).
  if (marketHours || extNow) {
    try {
      traderAgent.cache && (traderAgent.cache['market_scan'] = null); // force fresh each minute
      const scan = await traderAgent.scanMarket();
      const n = Array.isArray(scan && scan.signals) ? scan.signals.length : 0;
      if (n) console.log(`[Trading] autoscan — ${n} signal(s)${marketHours ? '' : ' (extended hours)'}`);
      // Act stage: execute on EVERY connected IBKR account, not just one — so when a
      // second person links their account the autopilot trades both. TRADER_AUTO_USER,
      // if set, pins it to a single user (back-compat / testing). Dedupe by broker
      // account id so an alias (two userIds → same DUR… account) isn't traded twice.
      // Runs sequentially; every order still passes the per-account hard guard, and
      // `extended` routes pre/post-market fills through LMT + outsideRTH orders.
      const ibkrCreds = require('../lib/ibkr-credentials');
      const watchlistStore = require('../lib/watchlist-store');
      const users = process.env.TRADER_AUTO_USER ? [process.env.TRADER_AUTO_USER] : ibkrCreds.listUsers();
      const _seenAccts = new Set();
      for (const uid of users) {
        const acct = await _autoBridge.getIBKRAccount(uid).catch(() => null);
        if (!acct || !acct.account_id) continue;                 // not connected/authenticated
        if (_seenAccts.has(acct.account_id)) continue;            // alias → same account, skip
        _seenAccts.add(acct.account_id);
        // Trade each user's OWN watchlist: filter the (union) scan to this user's symbols
        // so entries/signal-exits only touch names they curated. Held-position exits
        // (trailing/momentum) still run for ALL of the account's longs, watchlist or not.
        const wl = new Set(watchlistStore.getWatchlist(uid).map((s) => String(s).toUpperCase()));
        const userScan = { ...scan, signals: (scan.signals || []).filter((s) => wl.has(String((s && (s.symbol || s.ticker)) || '').toUpperCase())) };
        const at = await runAutoTrade(userScan, { bridge: _autoBridge, userId: uid, extended: !marketHours });
        for (const e of (at.executed || [])) {
          console.log(`[AutoTrader:${acct.account_id}] ${e.action} ${e.symbol} x${e.qty} → ${e.result && e.result.status}${e.reason ? ` (${e.reason})` : ''}`);
        }
        if ((at.enabled || at.manageExits) && !(at.executed || []).length && at.reason) console.log(`[AutoTrader:${acct.account_id}] no action — ${at.reason}`);
      }
    } catch (e) {
      console.error('[Trading] autoscan failed:', e.message);
    }
  }
  if (!_autoscanStopped) setTimeout(_autoscanTick, (marketHours || extNow) ? AUTOSCAN_MS : AUTOSCAN_CLOSED_MS);
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
    tradingMemory, tradingStore, tradingNews, readJsonCached, getEffectiveUserId: effectiveUserId,
    recordOrder, recordSignal, queryRecentTradingRecords,
    getStrategyFitness, logPerformance, tradeHistory,
    DASHBOARD_PROXY_ROUTES, DIRECT_DASHBOARD_PROXY_PATHS,
    AI_TRADER_HOST, AI_TRADER_PORT,
  };


  // GET/POST /api/trading/extended-hours — read or flip pre-market / after-hours trading.
  // ?set=on|off|toggle changes it; GET with no param just reads. When on, the trader also
  // scans + acts during the extended session (04:00–09:30 / 16:00–20:00 ET) via LMT +
  // outsideRTH orders. Regular-hours trading is unaffected either way.
  if (url.pathname === '/api/trading/extended-hours' || url.pathname === '/api/trading/overnight-scan') {
    const set = (url.searchParams.get('set') || '').toLowerCase();
    if (set === 'on') _extendedTrading = true;
    else if (set === 'off') _extendedTrading = false;
    else if (set === 'toggle') _extendedTrading = !_extendedTrading;
    sendJson(res, { enabled: _extendedTrading, marketHours: _isUsMarketHours(), extendedHours: _isUsExtendedHours() }, 200);
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


