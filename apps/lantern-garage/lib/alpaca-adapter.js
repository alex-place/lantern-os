'use strict';

/**
 * alpaca-adapter.js — Alpaca Trading API client (ADR-0027).
 *
 * Two auth modes, resolved per user:
 *   1. Per-user OAuth token (alpaca-credentials.js) — the user's OWN connected
 *      account, from the one-click flow.
 *   2. Server API keys (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY) — a shared
 *      Alpaca account the operator configures. Defaults to the PAPER endpoint so
 *      everyone can paper-trade a real Alpaca account without connecting anything.
 * A user's own OAuth account wins when present; otherwise the server keys apply.
 *
 * Implements the normalized surface the UI/autopilot read: getAccount /
 * getPositions / getOpenOrders / getDayPnl / placeOrder.
 *
 * SAFETY: PAPER orders are Alpaca-simulated money — they are NOT guard-blocked
 * (blocking them was the whole "paper trade silently fails" bug). Only LIVE
 * orders pass trading-guard (dry unless TRADER_LIVE=1) AND require
 * TRADER_ALLOW_LIVE_ACCOUNT=1. So paper testing just works; real money stays gated.
 */

const https = require('https');
const store = require('./alpaca-credentials');
const { orderGate } = require('./trading-guard');

const HOSTS = { paper: 'paper-api.alpaca.markets', live: 'api.alpaca.markets' };

function _serverKeys() {
  // Accept every common spelling of the Alpaca server keys. The trader docs and the
  // shipped .env use ALPACA_API_KEY / ALPACA_SECRET_KEY; the official Alpaca SDK uses
  // APCA_API_KEY_ID / APCA_API_SECRET_KEY; older code here used ALPACA_API_KEY_ID /
  // ALPACA_API_SECRET_KEY. Reading only the last set meant correctly-configured keys
  // (ALPACA_API_KEY / ALPACA_SECRET_KEY) silently didn't load, so the Alpaca paper
  // account showed "disconnected" / $0.00 even though credentials were present.
  const id =
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_API_KEY ||
    process.env.APCA_API_KEY_ID ||
    '';
  const secret =
    process.env.ALPACA_API_SECRET_KEY ||
    process.env.ALPACA_API_SECRET ||
    process.env.ALPACA_SECRET_KEY ||
    process.env.APCA_API_SECRET_KEY ||
    '';
  if (!id || !secret) return null;
  // Server keys default to PAPER unless explicitly ALPACA_ENV=live.
  const env = process.env.ALPACA_ENV === 'live' ? 'live' : 'paper';
  return { id, secret, env };
}

// The Sigma Trader (the long-horizon allocation book) runs on its OWN account so it
// never collides with the day-trader on the shared book. Its identity resolves ONLY
// to a dedicated account — its own connected OAuth (stored under SIGMA_USER) or its
// own SIGMA_ALPACA_* keys — and DELIBERATELY does NOT fall back to the shared server
// keys. No dedicated account → null → the engine plans but refuses to trade.
const SIGMA_USER = 'sigma-trader';
const CHAMPION_USER = 'champion-book';   // investor identity — dedicated account only
const OVERNIGHT_USER = 'overnight-book'; // overnight sleeve book — dedicated account only
function _sigmaKeys() {
  const id = process.env.SIGMA_ALPACA_API_KEY_ID || '';
  const secret = process.env.SIGMA_ALPACA_API_SECRET_KEY || '';
  if (!id || !secret) return null;
  const env = process.env.SIGMA_ALPACA_ENV === 'live' ? 'live' : 'paper';
  return { id, secret, env };
}

/** Resolve auth for a user: their OAuth token first, else server keys. Returns
 *  { host, headers, env, accountLabel } or null when neither is configured. */
function _authFor(userId) {
  // Champion book → its OWN dedicated account only (operator rule 2026-07-26: the
  // Champion is an INVESTOR, never on the same account as the traders — the same
  // no-borrowing contract Sigma has). CHAMPION_ALPACA_* keys or a connection
  // stored under 'champion-book'; no fallback to the shared server keys.
  if (userId === CHAMPION_USER) {
    const own = store.load(CHAMPION_USER);
    if (own && own.access_token) {
      const env = own.env === 'live' ? 'live' : 'paper';
      return { host: HOSTS[env], env, source: 'champion-oauth', accountLabel: own.account_number || null,
        headers: { Authorization: `Bearer ${own.access_token}` } };
    }
    const id = process.env.CHAMPION_ALPACA_API_KEY_ID || '';
    const secret = process.env.CHAMPION_ALPACA_API_SECRET_KEY || '';
    if (id && secret) {
      const env = process.env.CHAMPION_ALPACA_ENV === 'live' ? 'live' : 'paper';
      return { host: HOSTS[env], env, source: 'champion-keys', accountLabel: null,
        headers: { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret } };
    }
    return null;   // no dedicated account — do NOT borrow the traders' account
  }
  // Overnight book → its OWN account only (operator rule 2026-07-27: the intraday
  // day-trader and the overnight sleeve book must not share a book, so each engine's
  // P&L is INDEPENDENTLY measurable — entangled equity makes "did the overnight book
  // make money?" unanswerable. Same no-borrowing contract as Sigma/Champion.
  if (userId === OVERNIGHT_USER) {
    const own = store.load(OVERNIGHT_USER);
    if (own && own.access_token) {
      const env = own.env === 'live' ? 'live' : 'paper';
      return { host: HOSTS[env], env, source: 'overnight-oauth', accountLabel: own.account_number || null,
        headers: { Authorization: `Bearer ${own.access_token}` } };
    }
    const id = process.env.OVERNIGHT_ALPACA_API_KEY_ID || '';
    const secret = process.env.OVERNIGHT_ALPACA_API_SECRET_KEY || '';
    if (id && secret) {
      const env = process.env.OVERNIGHT_ALPACA_ENV === 'live' ? 'live' : 'paper';
      return { host: HOSTS[env], env, source: 'overnight-keys', accountLabel: null,
        headers: { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret } };
    }
    return null;   // no dedicated account — do NOT borrow the day-trader's
  }
  // Sigma Trader → its OWN account only (never the shared server keys).
  if (userId === SIGMA_USER) {
    const own = store.load(SIGMA_USER);
    if (own && own.access_token) {
      const env = own.env === 'live' ? 'live' : 'paper';
      return { host: HOSTS[env], env, source: 'sigma-oauth', accountLabel: own.account_number || null,
        headers: { Authorization: `Bearer ${own.access_token}` } };
    }
    const sk = _sigmaKeys();
    if (sk) return { host: HOSTS[sk.env], env: sk.env, source: 'sigma-keys', accountLabel: null,
      headers: { 'APCA-API-KEY-ID': sk.id, 'APCA-API-SECRET-KEY': sk.secret } };
    return null;   // no dedicated account — do NOT borrow the day-trader's
  }
  const c = store.load(userId);
  if (c && c.access_token) {
    const env = c.env === 'live' ? 'live' : 'paper';
    return { host: HOSTS[env], env, source: 'oauth', accountLabel: c.account_number || null,
      headers: { Authorization: `Bearer ${c.access_token}` } };
  }
  // The user's OWN pasted API keys (bring-your-own-keys — the primary connect path
  // while Alpaca OAuth is inactive). Their own account wins over the shared server keys.
  if (c && c.api_key_id && c.api_secret_key) {
    const env = c.env === 'live' ? 'live' : 'paper';
    return { host: HOSTS[env], env, source: 'user-keys', accountLabel: c.account_number || null,
      headers: { 'APCA-API-KEY-ID': c.api_key_id, 'APCA-API-SECRET-KEY': c.api_secret_key } };
  }
  // The shared operator keys. NOT for ordinary signed-in users (#2546): falling through to
  // them pooled every user who hadn't connected BYOK into ONE account, so person B saw
  // person A's positions and orders and the Free-tier promise of "your own paper-trading
  // account" was false. That is a privacy bug, not just a product gap.
  //
  // Server keys now serve only the identities they were meant for:
  //   - the owner on a single-user / auth-off box, where every trading route resolves the
  //     uid as null or 'local-owner' (routes/accounts.js convention), and
  //   - the named engine identities handled above (sigma / champion / overnight), which
  //     return before reaching here.
  // A real signed-in profile id gets NO shared account — it connects its own Alpaca paper
  // account with BYOK keys (POST /api/broker/alpaca/connect-keys), and until it does, the
  // broker facade hands it the per-user house practice account (lib/house-paper-broker.js).
  //
  // ALPACA_SHARED_KEYS_FOR_ALL=1 restores the old pooled behavior for an operator who
  // deliberately wants one shared account (e.g. a private single-tenant deployment).
  const isOwnerIdentity = userId == null || userId === '' || userId === 'local-owner';
  if (isOwnerIdentity || process.env.ALPACA_SHARED_KEYS_FOR_ALL === '1') {
    const k = _serverKeys();
    if (k) {
      return { host: HOSTS[k.env], env: k.env, source: 'server-keys', accountLabel: null,
        headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } };
    }
  }
  return null;
}

/** True when SOME Alpaca account is usable for this user (own OAuth or server keys). */
function available(userId) { return !!_authFor(userId); }

function _req(auth, method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: auth.host, path, method,
      headers: {
        ...auth.headers,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_e) { /* non-JSON */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Account summary, normalized. Null when no Alpaca account is available. */
async function getAccount(userId) {
  const auth = _authFor(userId);
  if (!auth) return null;
  const r = await _req(auth, 'GET', '/v2/account');
  if (!r.ok || !r.json) return null;
  const a = r.json;
  const equity = Number(a.equity) || 0;
  const lastEquity = Number(a.last_equity) || equity;
  const day = equity - lastEquity;
  return {
    account_id: a.account_number || auth.accountLabel || 'ALPACA',
    equity,
    cash: Number(a.cash) || 0,
    unrealized: 0,                          // per-position; summed in getPositions
    realized_today: 0,
    pnl_today: day,
    pnl_pct: equity ? (day / equity) * 100 : 0,
    buying_power: Number(a.buying_power) || 0,
    mode: auth.env === 'live' ? 'live' : 'paper',
    source: 'alpaca',
  };
}

/** Open positions, normalized to the shape the positions table renders. */
async function getPositions(userId) {
  const auth = _authFor(userId);
  if (!auth) return null;
  const r = await _req(auth, 'GET', '/v2/positions');
  if (!r.ok || !Array.isArray(r.json)) return { positions: [], source: 'alpaca' };
  const positions = r.json.map((p) => ({
    symbol: p.symbol,
    qty: Number(p.qty),
    side: (Number(p.qty) < 0 ? 'short' : 'long'),
    avg_entry_price: Number(p.avg_entry_price) || 0,
    current_price: Number(p.current_price) || 0,
    market_value: Number(p.market_value) || 0,
    unrealized_pl: Number(p.unrealized_pl) || 0,
    pnl_pct: Number(p.unrealized_plpc) != null ? Number(p.unrealized_plpc) * 100 : 0,
  }));
  return { positions, source: 'alpaca' };
}

/** Place an order on the resolved Alpaca account. PAPER fills for real (no guard);
 *  LIVE passes trading-guard + needs TRADER_ALLOW_LIVE_ACCOUNT=1. Normalized shape. */
async function placeOrder(userId, { ticker, side, qty, type, limitPrice, stopPrice, timeInForce, stopLoss, equity }) {
  const auth = _authFor(userId);
  if (!auth) return null;                                // no Alpaca account → caller falls back
  const mode = auth.env === 'live' ? 'live' : 'paper';
  const base = { order_id: null, ticker, side, qty, type: type || 'market', mode, source: 'alpaca' };

  if (mode === 'live') {
    // Real money: the same double gate as the IBKR path.
    let eq = Number(equity) || 0;
    if (!eq) { const acct = await getAccount(userId).catch(() => null); eq = (acct && acct.equity) || 0; }
    const gate = orderGate({ mode, qty: Number(qty), price: Number(limitPrice) || 0, equity: eq });
    if (process.env.TRADER_ALLOW_LIVE_ACCOUNT !== '1') {
      return { ...base, status: 'dry_run', dry: true, reason: 'live Alpaca account — set TRADER_ALLOW_LIVE_ACCOUNT=1 to arm real-money orders' };
    }
    if (!gate.allowed) return { ...base, status: 'dry_run', dry: true, reason: gate.reason };
  }
  // PAPER: simulated by Alpaca, no real money — send it, no guard.

  const t = String(type || 'market').toLowerCase();
  const stopPx = stopPrice || (t === 'stop' ? limitPrice : null);
  const tif = String(timeInForce || 'day').toLowerCase() === 'gtc' ? 'gtc' : 'day';
  const order = {
    symbol: ticker,
    qty: String(Math.abs(Number(qty) || 0)),
    side: String(side).toLowerCase(),
    type: t === 'limit' ? 'limit' : t === 'stop' ? 'stop' : 'market',
    time_in_force: tif,
    ...(t === 'limit' && limitPrice ? { limit_price: String(limitPrice) } : {}),
    ...(t === 'stop' && stopPx ? { stop_price: String(stopPx) } : {}),
    ...(t !== 'stop' && stopLoss ? { order_class: 'oto', stop_loss: { stop_price: String(stopLoss) } } : {}),
  };
  const r = await _req(auth, 'POST', '/v2/orders', order);
  if (r.ok && r.json && r.json.id) {
    const fp = r.json.filled_avg_price != null ? Number(r.json.filled_avg_price) : null;
    return { ...base, status: 'placed', order_id: r.json.id, dry: false,
      fill_price: fp || undefined, reason: `${mode} order accepted by Alpaca` };
  }
  const reason = (r.json && (r.json.message || r.json.error)) || r.error || `HTTP ${r.status}`;
  return { ...base, status: 'error', dry: false, reason, error: reason };
}

/** Open (working) orders, statuses normalized to 'submitted' so the autopilot's
 *  guard regexes match the same way they do for IBKR. */
async function getOpenOrders(userId) {
  const auth = _authFor(userId);
  if (!auth) return [];
  const r = await _req(auth, 'GET', '/v2/orders?status=open&limit=200');
  if (!r.ok || !Array.isArray(r.json)) return [];
  const WORKING = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'accepted_for_bidding']);
  return r.json.map((o) => ({
    symbol: o.symbol, side: o.side, orderType: o.type,
    status: WORKING.has(String(o.status)) ? 'submitted' : String(o.status),
    qty: Number(o.qty) || 0, order_id: o.id,
  }));
}

/** Full order list (open + closed) for the Orders / Order-history tabs, newest first,
 *  normalized to the UI shape. `status=all` so filled/cancelled orders populate history. */
async function getAllOrders(userId, limit = 200) {
  const auth = _authFor(userId);
  if (!auth) return [];
  const n = Math.min(500, Math.max(1, Number(limit) || 200));
  const r = await _req(auth, 'GET', `/v2/orders?status=all&limit=${n}&direction=desc&nested=false`);
  if (!r.ok || !Array.isArray(r.json)) return [];
  const norm = (s) => {
    const x = String(s || '').toLowerCase();
    if (/fill/.test(x)) return 'filled';
    if (/cancel|expired|rejected|replaced|done_for_day/.test(x)) return 'canceled';
    if (/new|accepted|pending|held|partially/.test(x)) return 'open';
    return x || 'unknown';
  };
  return r.json.map((o) => ({
    id: o.id, symbol: o.symbol, side: String(o.side || '').toLowerCase(),
    qty: Number(o.qty) || Number(o.filled_qty) || 0,
    type: String(o.type || 'market').toLowerCase(),
    limit_price: o.limit_price != null ? Number(o.limit_price) : (o.stop_price != null ? Number(o.stop_price) : null),
    status: norm(o.status),
    filled_avg_price: Number(o.filled_avg_price) || 0,
    filled_at: o.filled_at || '', created_at: o.submitted_at || o.created_at || '',
  }));
}

async function getDayPnl(userId) {
  const acct = await getAccount(userId).catch(() => null);
  if (!acct) return null;
  return { dailyPnl: acct.pnl_today, unrealizedPnl: acct.unrealized, realizedPnl: acct.realized_today };
}

// Tradable US-equity/ETF universe, for the symbol-search popup. The list is large
// (~11k) and stable, so cache it in-process for a day keyed by env — one fetch serves
// every user on the same account type. Returns [{symbol,name,exchange,class,tradable}].
let _assetCache = { env: null, at: 0, list: [] };
const _ASSET_TTL = 24 * 60 * 60 * 1000;
async function listAssets(userId) {
  const auth = _authFor(userId);
  if (!auth) return [];
  const now = Date.now();
  if (_assetCache.env === auth.env && (now - _assetCache.at) < _ASSET_TTL && _assetCache.list.length) {
    return _assetCache.list;
  }
  const r = await _req(auth, 'GET', '/v2/assets?status=active&asset_class=us_equity');
  if (!r.ok || !Array.isArray(r.json)) return _assetCache.list;   // keep any prior cache on failure
  const list = r.json
    .filter((a) => a && a.tradable && a.symbol)
    .map((a) => ({ symbol: a.symbol, name: a.name || a.symbol, exchange: a.exchange || '', class: 'us_equity', tradable: true }));
  _assetCache = { env: auth.env, at: now, list };
  return list;
}

/** Cancel a single working order by id. Returns true on 2xx/207. */
async function cancelOrder(userId, orderId) {
  const auth = _authFor(userId);
  if (!auth || !orderId) return false;
  const r = await _req(auth, 'DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
  return r.ok || r.status === 207 || r.status === 404;   // 404 = already gone → treat as cancelled
}

/** Cancel every working order for a symbol (frees reserved shares before a rebalance
 *  sell). Returns the count cancelled. */
async function cancelOpenOrders(userId, symbol) {
  const sym = String(symbol || '').toUpperCase();
  const open = await getOpenOrders(userId).catch(() => []);
  let n = 0;
  for (const o of open) {
    if (String(o.symbol || '').toUpperCase() === sym && o.order_id) {
      if (await cancelOrder(userId, o.order_id)) n += 1;
    }
  }
  return n;
}

// Range → Alpaca (period, timeframe). Alpaca's portfolio-history takes a period
// ("1D"/"1W"/"1M"/"3M"/"1A"/"all") + a bar timeframe. Intraday ranges use fine
// bars; multi-month ranges use daily bars. YTD has no native period, so it's
// computed as "<n>D" from Jan 1. The equity curve (Robinhood-style) is drawn from
// the returned `equity[]` aligned to `timestamp[]`.
const HISTORY_RANGES = {
  '1D':  { period: '1D',  timeframe: '5Min' },
  '1W':  { period: '1W',  timeframe: '1H' },
  '1M':  { period: '1M',  timeframe: '1D' },
  '3M':  { period: '3M',  timeframe: '1D' },
  '1Y':  { period: '1A',  timeframe: '1D' },
  'ALL': { period: 'all', timeframe: '1D' },
};

/** Portfolio equity history for the Robinhood-style chart. `range` is one of
 *  1D/1W/1M/3M/YTD/1Y/ALL. Returns { ok, range, timestamps, equity, base_value,
 *  timeframe } or { ok:false } when no Alpaca account is available. */
async function getPortfolioHistory(userId, range = '1D') {
  const auth = _authFor(userId);
  if (!auth) return { ok: false, reason: 'no Alpaca account' };
  let cfg = HISTORY_RANGES[range];
  const params = new URLSearchParams({ extended_hours: 'true' });
  if (range === 'YTD') {
    const now = new Date();
    const days = Math.max(1, Math.ceil((now - new Date(now.getUTCFullYear(), 0, 1)) / 86400000));
    params.set('period', `${days}D`);
    params.set('timeframe', '1D');
  } else {
    if (!cfg) cfg = HISTORY_RANGES['1D'];
    params.set('period', cfg.period);
    params.set('timeframe', cfg.timeframe);
    // Intraday ranges: report continuously so the curve isn't chopped at each close.
    if (cfg.timeframe !== '1D') params.set('intraday_reporting', 'continuous');
  }
  const r = await _req(auth, 'GET', `/v2/account/portfolio/history?${params.toString()}`);
  if (!r.ok || !r.json || !Array.isArray(r.json.timestamp)) {
    return { ok: false, reason: (r.json && r.json.message) || r.error || `HTTP ${r.status}` };
  }
  const ts = r.json.timestamp || [];
  const eq = (r.json.equity || []).map((v) => (v == null ? null : Number(v)));
  return {
    ok: true,
    range,
    timeframe: r.json.timeframe || params.get('timeframe'),
    base_value: Number(r.json.base_value) || (eq.find((v) => v != null) || 0),
    timestamps: ts,
    equity: eq,
    source: 'alpaca',
  };
}

module.exports = { available, getAccount, getPositions, getOpenOrders, getAllOrders, getDayPnl, getPortfolioHistory, placeOrder, cancelOrder, cancelOpenOrders, listAssets, _authFor, SIGMA_USER, CHAMPION_USER, OVERNIGHT_USER, overnightAvailable: () => !!_authFor(OVERNIGHT_USER), sigmaAvailable: () => !!_authFor(SIGMA_USER), championAvailable: () => !!_authFor(CHAMPION_USER) };
