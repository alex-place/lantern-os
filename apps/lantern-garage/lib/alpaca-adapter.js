'use strict';

/**
 * alpaca-adapter.js — per-user Alpaca Trading API client (ADR-0027).
 *
 * Implements the same normalized surface the trading UI/autopilot already consume
 * from the IBKR path: getAccount(), getPositions(), placeOrder(). The user's own
 * OAuth2 bearer token (from alpaca-credentials.js) authorizes every call — we never
 * hold Alpaca API keys, only the per-user token the user granted via one click.
 *
 * SAFETY: placeOrder() still passes lib/trading-guard.js — dry unless TRADER_LIVE=1
 * — exactly like the IBKR adapter. The broker changing does NOT relax the arm
 * switch. Paper env is the default and needs no live-account double-opt-in; a live
 * env token additionally requires TRADER_ALLOW_LIVE_ACCOUNT=1 (parity with IBKR).
 */

const https = require('https');
const store = require('./alpaca-credentials');
const { orderGate } = require('./trading-guard');

const HOSTS = {
  paper: 'paper-api.alpaca.markets',
  live: 'api.alpaca.markets',
};

function _req(host, token, method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host, path, method,
      headers: {
        Authorization: `Bearer ${token}`,
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

function _hostFor(creds) { return HOSTS[creds && creds.env === 'live' ? 'live' : 'paper']; }

/** Account summary in the normalized shape the footer/UI already reads. Null when
 *  the user hasn't connected Alpaca — the caller falls back to its default path. */
async function getAccount(userId) {
  const c = store.load(userId);
  if (!c || !c.access_token) return null;
  const r = await _req(_hostFor(c), c.access_token, 'GET', '/v2/account');
  if (!r.ok || !r.json) return null;
  const a = r.json;
  const equity = Number(a.equity) || 0;
  const lastEquity = Number(a.last_equity) || equity;
  const day = equity - lastEquity;
  return {
    account_id: a.account_number || c.account_number || null,
    equity,
    cash: Number(a.cash) || 0,
    unrealized: 0,                          // per-position; summed in getPositions
    realized_today: 0,
    pnl_today: day,
    pnl_pct: equity ? (day / equity) * 100 : 0,
    buying_power: Number(a.buying_power) || 0,
    mode: c.env === 'live' ? 'live' : 'paper',
    source: 'alpaca',
  };
}

/** Open positions, normalized to the shape the positions table renders. */
async function getPositions(userId) {
  const c = store.load(userId);
  if (!c || !c.access_token) return null;
  const r = await _req(_hostFor(c), c.access_token, 'GET', '/v2/positions');
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

/** Place an order on the user's OWN Alpaca account. HARD-GATED by trading-guard
 *  (dry unless TRADER_LIVE=1); returns the normalized shape the UI consumes:
 *  { status:'placed'|'dry_run'|'error', order_id, ticker, ... }. */
async function placeOrder(userId, { ticker, side, qty, type, limitPrice, stopPrice, timeInForce, stopLoss, equity }) {
  const c = store.load(userId);
  if (!c || !c.access_token) return null;               // not connected → caller falls back
  const mode = c.env === 'live' ? 'live' : 'paper';

  // Same arm gate as IBKR. Live env needs the extra opt-in; paper does not.
  let eq = Number(equity) || 0;
  if (!eq) { const acct = await getAccount(userId).catch(() => null); eq = (acct && acct.equity) || 0; }
  const gate = orderGate({ mode, qty: Number(qty), price: Number(limitPrice) || 0, equity: eq });
  if (mode === 'live' && process.env.TRADER_ALLOW_LIVE_ACCOUNT !== '1') {
    gate.allowed = false; gate.dry = true;
    gate.reason = 'live Alpaca account — set TRADER_ALLOW_LIVE_ACCOUNT=1 to arm real-money orders';
  }
  const base = { order_id: null, ticker, side, qty, type: type || 'market', mode, source: 'alpaca' };
  if (!gate.allowed) return { ...base, status: 'dry_run', dry: true, reason: gate.reason };

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
    // A standalone protective stop (the autopilot's GTC SELL STP) uses stop_price.
    ...(t === 'stop' && stopPx ? { stop_price: String(stopPx) } : {}),
    // A market/limit entry can carry a protective stop as a one-triggers-other bracket.
    ...(t !== 'stop' && stopLoss ? { order_class: 'oto', stop_loss: { stop_price: String(stopLoss) } } : {}),
  };
  const r = await _req(_hostFor(c), c.access_token, 'POST', '/v2/orders', order);
  if (r.ok && r.json && r.json.id) {
    return { ...base, status: 'placed', order_id: r.json.id, dry: false, reason: `armed on ${mode} account` };
  }
  const reason = (r.json && (r.json.message || r.json.error)) || r.error || `HTTP ${r.status}`;
  return { ...base, status: 'error', dry: false, reason, error: reason };
}

/** Open (working) orders, normalized to the shape the autopilot's guards expect:
 *  { symbol, side, orderType, status }. Alpaca's working statuses (new/accepted/
 *  pending_new/partially_filled/held) are mapped to 'submitted' so the autopilot's
 *  /submit|pending|presubmit|working/ regexes match the same way they do for IBKR. */
async function getOpenOrders(userId) {
  const c = store.load(userId);
  if (!c || !c.access_token) return [];
  const r = await _req(_hostFor(c), c.access_token, 'GET', '/v2/orders?status=open&limit=200');
  if (!r.ok || !Array.isArray(r.json)) return [];
  const WORKING = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'accepted_for_bidding']);
  return r.json.map((o) => ({
    symbol: o.symbol,
    side: o.side,                                   // buy | sell
    orderType: o.type,                              // market | limit | stop | stop_limit
    status: WORKING.has(String(o.status)) ? 'submitted' : String(o.status),
    qty: Number(o.qty) || 0,
    order_id: o.id,
  }));
}

/** Day P&L in the shape the autopilot reads ({ dailyPnl }). Alpaca gives it as
 *  equity − last_equity on the account. */
async function getDayPnl(userId) {
  const acct = await getAccount(userId).catch(() => null);
  if (!acct) return null;
  return { dailyPnl: acct.pnl_today, unrealizedPnl: acct.unrealized, realizedPnl: acct.realized_today };
}

module.exports = { getAccount, getPositions, getOpenOrders, getDayPnl, placeOrder, _hostFor };
