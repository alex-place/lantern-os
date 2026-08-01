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
const accountLock = require('../lib/account-lock');       // one account, one managing process
const _lockNoticed = new Set();                          // accounts we've already logged a stand-down for
const _autoBridge = new TradingAPIBridge();               // shared: keeps the LST cache warm across scans
let _autoscanStopped = false;
// Champion is a SLOW allocation book — it must not rebalance every autoscan tick like
// the day-trader. Throttle to at most once per hour per user (the no-churn band means
// most runs are no-ops anyway, but this avoids the per-tick bar fetch + order churn).
const _championLastRun = new Map();
const CHAMPION_MIN_INTERVAL_MS = 60 * 60 * 1000;
function _championDue(uid, now) {
  const last = _championLastRun.get(uid) || 0;
  if (now - last < CHAMPION_MIN_INTERVAL_MS) return false;
  _championLastRun.set(uid, now);
  return true;
}
// Extended-hours (pre-market / after-hours) trading — OFF by default. When on (⏰ toggle
// or TRADER_EXTENDED_HOURS=1) the trader also scans + acts during the extended session,
// placing marketable-limit + outsideRTH orders (regular hours use market orders as before).
let _extendedTrading = process.env.TRADER_EXTENDED_HOURS === '1';
async function _autoscanTick() {
  if (_autoscanStopped || !traderAgent) return;
  const marketHours = _isUsMarketHours();
  const extNow = _isUsExtendedHours() && _extendedTrading;   // only pre/post when the toggle is on
  // Asymmetric-options SHADOW trader (Verify stage): measurement only, never orders.
  // Self-throttles to its own close/open ET windows; fail-soft so it can't break scans.
  try { require('../lib/options-shadow').tick().catch(() => {}); } catch (_e) { /* absent/failed → skip */ }
  // Regular hours always run; extended hours only when the toggle is on. Otherwise idle
  // (no Python spawn / model call — the price collectors keep polling for free).
  if (marketHours || extNow) {
    // Overnight sleeve book (lib/overnight-trader.js): opt-in (OVERNIGHT_TRADER=1),
    // dry unless OVERNIGHT_ARM=1. Self-windowing (15:45 enter / 09:31 exit ET) — a
    // no-op on every other tick. Fail-soft: the scan loop must never die for it.
    try { await require('../lib/overnight-trader').tick({ bridge: _autoBridge }); } catch (_e) { /* fail-soft */ }
    try {
      traderAgent.cache && (traderAgent.cache['market_scan'] = null); // force fresh each minute
      const scan = await traderAgent.scanMarket();
      const n = Array.isArray(scan && scan.signals) ? scan.signals.length : 0;
      if (n) console.info(`[Trading] autoscan — ${n} signal(s)${marketHours ? '' : ' (extended hours)'}`);
      // Act stage: execute on EVERY connected IBKR account, not just one — so when a
      // second person links their account the autopilot trades both. TRADER_AUTO_USER,
      // if set, pins it to a single user (back-compat / testing). Dedupe by broker
      // account id so an alias (two userIds → same DUR… account) isn't traded twice.
      // Runs sequentially; every order still passes the per-account hard guard, and
      // `extended` routes pre/post-market fills through LMT + outsideRTH orders.
      const ibkrCreds = require('../lib/ibkr-credentials');
      const alpacaCreds = require('../lib/alpaca-credentials');
      const watchlistStore = require('../lib/watchlist-store');
      const { brokerFacadeFor } = require('../lib/broker-facade');
      // Drive EVERY connected account — IBKR (ADR-0022) or one-click Alpaca (ADR-0027),
      // deduped. TRADER_AUTO_USER pins to one user (back-compat/testing). Per user the
      // broker facade resolves to their actual broker (IBKR preferred), so runAutoTrade
      // is broker-agnostic; every order still passes the per-account hard guard.
      // Enumerate accounts to manage. Per-user credential FILES (IBKR / one-click Alpaca)
      // give a userId each. BUT the common single-operator setup runs on Alpaca *server
      // env keys* (or the local IBKR) under the id-less 'local-owner' identity — which has
      // NO credential file, so it was invisible to the autopilot and its positions were
      // never stopped/exited (losers ran unbounded). When the login gate is OFF (local /
      // preview box), include 'local-owner' so that account IS managed. brokerFacadeFor
      // returns null if nothing is actually connected for it, and the per-account dedupe
      // below drops it if it aliases a file-backed account — so this can't double-trade.
      let baseUsers = process.env.TRADER_AUTO_USER
        ? [process.env.TRADER_AUTO_USER]
        : [...ibkrCreds.listUsers(), ...alpacaCreds.listUsers()];
      if (!process.env.TRADER_AUTO_USER) {
        try {
          const { loginGateEnabled } = require('../lib/auth-middleware');
          if (!loginGateEnabled()) baseUsers.push('local-owner');
        } catch (_e) { baseUsers.push('local-owner'); }   // auth module absent → single-user box
      }
      const users = [...new Set(baseUsers)];
      const traderMode = require('../lib/trader-mode');
      const sigma = require('../lib/sigma-trader');
      const _seenAccts = new Set();
      for (const uid of users) {
        // AI-autopilot tier gate (operator tiering 2026-07-26): the autonomous
        // trader is a $200 Pilot capability. Follows PLAN_ENFORCEMENT like every
        // plan gate — unset, behavior unchanged. local-owner is the operator.
        if (process.env.PLAN_ENFORCEMENT === '1' && uid !== 'local-owner') {
          try {
            const { getProfile } = require('../lib/user-profiles');
            const role = String(((getProfile(uid) || {}).role) || 'guest');
            const pm = require('../lib/plan-matrix');
            if (!pm.roleHasCapability(role, 'ai_trader')) continue;   // not Pilot → no autopilot
          } catch (_e) { /* profile store unavailable → fail open (legacy behavior) */ }
        }
        const resolved = await brokerFacadeFor(uid, _autoBridge).catch(() => null);
        if (!resolved || !resolved.accountId) continue;          // neither broker connected
        if (_seenAccts.has(resolved.accountId)) continue;        // alias → same account, skip
        _seenAccts.add(resolved.accountId);
        // CROSS-PROCESS ACCOUNT LOCK (lib/account-lock.js). _seenAccts only dedupes
        // within THIS process; on 2026-07-31 the stable and dev servers both drove
        // IBKR DUR193395 with separate cooldown state and double-submitted. One
        // account is managed by one process — the other stands down for this tick.
        // Covers BOTH strategies below (champion rebalance and the day-trader), since
        // either would place orders on this account. Fails OPEN if the lock is
        // unreadable: an unmanaged position is worse than a duplicate order.
        const _lock = accountLock.acquire(resolved.accountId);
        if (!_lock.acquired) {
          if (!_lockNoticed.has(resolved.accountId)) {          // log the change, not every tick
            _lockNoticed.add(resolved.accountId);
            console.info(`[Trading] account ${resolved.accountId} managed by another process — standing down (${_lock.reason})`);
          }
          continue;
        }
        _lockNoticed.delete(resolved.accountId);
        // ACTIVE-TRADER switch (Phase 2): one account, one strategy. A 'champion' user
        // has the day-trader PAUSED — instead we run the Champion allocation book on
        // their own account (throttled; DRY unless SIGMA_ARM=1, same governance as the
        // standalone Sigma book). Default 'stock' users fall through to runAutoTrade.
        if (traderMode.get(uid) === 'champion') {
          if (_championDue(uid, Date.now())) {
            await sigma.rebalanceNow({ userId: uid, arm: true }).catch((e) => console.error('[Trading] champion rebalance failed:', e.message));
          }
          continue;                                              // day-trader paused for this account
        }
        // The AI trades each user's TRADELIST — its own user-editable universe — never
        // the watchlist (which is tracking-only now; manual buy/sell stays free on any
        // symbol). Filter the (union) scan to this user's tradelist so entries/signal-
        // exits only touch names they explicitly allowed the AI. Held-position exits
        // (trailing/momentum/backstop) still run for ALL of the account's longs.
        const tl = new Set(require('../lib/tradelist-store').getTradelist(uid).map((s) => String(s).toUpperCase()));
        const userScan = { ...scan, signals: (scan.signals || []).filter((s) => tl.has(String((s && (s.symbol || s.ticker)) || '').toUpperCase())) };
        // Every execution is already appended to the durable autopilot-trades.jsonl by
        // auto-trader.logTrade() — that append-only file is the record of what the
        // autopilot did, so a per-tick console echo here would only duplicate it.
        // Position partitioning: symbols the overnight sleeve book currently owns are
        // off-limits to the intraday engine (no exits/stops/sells/entries on them) —
        // each engine manages only its own positions. Fail-soft empty set.
        let _ovnHeld = [];
        try { _ovnHeld = [...require('../lib/overnight-trader').heldSymbols()]; } catch (_e) { /* absent → none */ }
        await runAutoTrade(userScan, { bridge: resolved.facade, userId: uid, extended: !marketHours, excludeSymbols: _ovnHeld });
      }
    } catch (e) {
      console.error('[Trading] autoscan failed:', e.message);
    }
  }
  if (!_autoscanStopped) setTimeout(_autoscanTick, (marketHours || extNow) ? AUTOSCAN_MS : AUTOSCAN_CLOSED_MS);
}
if (traderAgent && process.env.TRADER_AUTOSCAN !== '0') {
  setTimeout(_autoscanTick, 5000); // first scan shortly after boot
  console.info(`[Trading] autonomous scan loop started (every ${AUTOSCAN_MS}ms)`);
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
const tradelistRoutes = require('./trading/tradelist');
const allocatorRoutes = require('./trading/allocator');
const dashboardRoutes = require('./trading/dashboard');
const ibkrRoutes = require('./trading/ibkr');
const kalshiRoutes = require('./trading/kalshi');
const aiTraderRoutes = require('./trading/ai-trader');
const newsRoutes = require('./trading/news');
const miscRoutes = require('./trading/misc');
const portfolioRoutes = require('./trading/portfolio');
const optionsRoutes = require('./trading/options');
const brakeRoutes = require('./trading/brake');
const demoRoutes = require('./trading/demo');
const scorecardRoutes = require('./trading/scorecard');
const championRoutes = require('./trading/champion');
const sigmaRoutes = require('./trading/sigma');
const traderModeRoutes = require('./trading/mode');
const accountModeRoutes = require('./trading/account-mode');   // DEMO/PAPER/TRADE ladder (#2546)
const optionsShadowRoutes = require('./trading/options-shadow');
const overnightRoutes = require('./trading/overnight');


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
  if (await tradelistRoutes(req, res, url, ctx)) return true;
  if (await allocatorRoutes(req, res, url, ctx)) return true;
  if (await dashboardRoutes(req, res, url, ctx)) return true;
  if (await ibkrRoutes(req, res, url, ctx)) return true;
  if (await kalshiRoutes(req, res, url, ctx)) return true;
  if (await aiTraderRoutes(req, res, url, ctx)) return true;
  if (await newsRoutes(req, res, url, ctx)) return true;
  if (await portfolioRoutes(req, res, url, ctx)) return true;
  if (await optionsRoutes(req, res, url, ctx)) return true;
  if (await brakeRoutes(req, res, url, ctx)) return true;
  if (await demoRoutes(req, res, url, ctx)) return true;
  if (await scorecardRoutes(req, res, url, ctx)) return true;
  if (await championRoutes(req, res, url, ctx)) return true;
  if (await sigmaRoutes(req, res, url, ctx)) return true;
  if (await traderModeRoutes(req, res, url, ctx)) return true;
  if (await accountModeRoutes(req, res, url, ctx)) return true;
  if (await optionsShadowRoutes(req, res, url, ctx)) return true;
  if (await overnightRoutes(req, res, url, ctx)) return true;
  if (await miscRoutes(req, res, url, ctx)) return true;

  return false;
};


