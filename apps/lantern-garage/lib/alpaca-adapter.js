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
  const id = process.env.ALPACA_API_KEY_ID || '';
  const secret = process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';
  if (!id || !secret) return null;
  // Server keys default to PAPER unless explicitly ALPACA_ENV=live.
  const env = process.env.ALPACA_ENV === 'live' ? 'live' : 'paper';
  return { id, secret, env };
}

/** Resolve auth for a user: their OAuth token first, else server keys. Returns
 *  { host, headers, env, accountLabel } or null when neither is configured. */
function _authFor(userId) {
  const c = store.load(userId);
  if (c && c.access_token) {
    const env = c.env === 'live' ? 'live' : 'paper';
    return { host: HOSTS[env], env, source: 'oauth', accountLabel: c.account_number || null,
      headers: { Authorization: `Bearer ${c.access_token}` } };
  }
  const k = _serverKeys();
  if (k) {
    return { host: HOSTS[k.env], env: k.env, source: 'server-keys', accountLabel: null,
      headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } };
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

async function getDayPnl(userId) {
  const acct = await getAccount(userId).catch(() => null);
  if (!acct) return null;
  return { dailyPnl: acct.pnl_today, unrealizedPnl: acct.unrealized, realizedPnl: acct.realized_today };
}

module.exports = { available, getAccount, getPositions, getOpenOrders, getDayPnl, placeOrder, _authFor };
