/**
 * Trading routes — orders group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function ordersRoutes(req, res, url, ctx) {
  const { sendJson, collectRequestBody, bridge, traderAgent, tradingMemory, tradingStore, getEffectiveUserId } = ctx;


  // GET /api/trading/orders
  // Broker truth from Alpaca (#1714): every order the account submitted —
  // autonomous (Σ₀ engine) AND manual — so the Orders / Order-history tabs
  // reconcile with Positions and Realized P&L. The engine places straight to
  // Alpaca and never wrote to the old local tradingStore ledger, which is why
  // those tabs showed "None" while real positions and profit existed. Falls back
  // to the local ledger only if the broker call fails.
  if (url.pathname === '/api/trading/orders' && req.method === 'GET') {
    try {
      const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
      let orders = [];
      // Prefer the connected IBKR account's own orders (working + filled) so the
      // Orders / Order-history tabs reflect the autopilot's trades — the legacy
      // agent/ledger only knew manual orders, so history showed "None".
      const ibkr = await bridge.getIBKROpenOrders(getEffectiveUserId(req)).catch(() => null);
      if (Array.isArray(ibkr) && ibkr.length) {
        const norm = (s) => {
          const x = String(s || '').toLowerCase();
          if (/fill/.test(x)) return 'filled';
          if (/cancel/.test(x)) return 'canceled';
          if (/submit|presubmit|pending|inactive/.test(x)) return 'open';
          return x || 'unknown';
        };
        const tstr = (t) => { const n = Number(t); return n > 1e11 ? new Date(n).toISOString() : (t || ''); };
        orders = ibkr.map((o) => ({
          id: o.orderId, symbol: o.symbol, side: String(o.side || '').toLowerCase(),
          qty: o.qty, type: String(o.orderType || 'market').toLowerCase(),
          limit_price: o.orderType === 'STP' || o.orderType === 'LMT' ? o.price : null,
          status: norm(o.status), filled_avg_price: o.avgPrice || 0,
          filled_at: tstr(o.time), created_at: tstr(o.time),
        }));
        sendJson(res, orders, 200);
        return true;
      }
      if (traderAgent) {
        const r = await traderAgent.getOrders(limitParam > 0 ? limitParam : 50);
        orders = (r && Array.isArray(r.orders)) ? r.orders : [];
      }
      if (!orders.length) {
        // Fallback: local ledger (manual-only) if the broker returned nothing.
        const stored = tradingStore.listOrders(limitParam > 0 ? { limit: limitParam } : {});
        orders = stored.slice().reverse().map((o) => ({
          id: o.id || o.order_id || '', symbol: o.symbol || o.ticker || '',
          side: o.side || '', qty: o.qty || 0, type: o.type || o.order_type || 'market',
          limit_price: o.limit_price || null, status: o.status || 'unknown',
          filled_avg_price: o.filled_avg || o.price || 0,
          filled_at: o.filled_at || o.submitted_at || '', created_at: o.created_at || '',
        }));
      }
      sendJson(res, orders, 200);
    } catch (error) {
      console.error('[Trading] /orders error:', error.message);
      sendJson(res, [], 500);
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
  // Place an order (buy/sell) via the local TraderAgent → IBKR Client Portal.
  // HARD-GATED + dry by default (lib/trading-guard.js): a blocked order returns
  // status:'dry_run' (HTTP 200, not an error) carrying the reason.
  if (url.pathname === '/api/trading/orders/place' && req.method === 'POST') {
    if (!traderAgent) {
      sendJson(res, { status: 'error', error: 'TraderAgent not initialized' }, 503);
      return true;
    }
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const { ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit } = payload;
      if (!ticker || !['buy', 'sell'].includes(String(side || '').toLowerCase()) || !qty || Number(qty) <= 0) {
        sendJson(res, { status: 'error', error: 'ticker, side (buy/sell), and positive qty are required' }, 400);
        return true;
      }
      if (stopLoss != null && Number(stopLoss) <= 0) {
        sendJson(res, { status: 'error', error: 'stopLoss must be a positive number' }, 400);
        return true;
      }
      if (takeProfit != null && Number(takeProfit) <= 0) {
        sendJson(res, { status: 'error', error: 'takeProfit must be a positive number' }, 400);
        return true;
      }
      // Broker precedence: the user's connected IBKR account (ADR-0022), then their
      // one-click Alpaca account (ADR-0027), then the legacy env agent. First match
      // that isn't null wins. Every path is HARD-GATED inside its own placeOrder.
      const uid = getEffectiveUserId(req);
      const orderReq = { ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit };
      const alpaca = require('../../lib/alpaca-adapter');
      const { preferredBroker } = require('../../lib/broker-facade');
      // Broker precedence: connected IBKR → Alpaca (the user's own OAuth account,
      // else the operator's server paper keys), flipped by BROKER_PREFER=alpaca.
      // Either order keeps the other broker as fallback. Alpaca PAPER fills for
      // real without arming — so a paper trade actually happens instead of a
      // dry-run dead end.
      const attempts = preferredBroker(uid) === 'alpaca'
        ? [() => alpaca.placeOrder(uid, orderReq), () => bridge.placeIBKROrder(uid, orderReq)]
        : [() => bridge.placeIBKROrder(uid, orderReq), () => alpaca.placeOrder(uid, orderReq)];
      let result = null;
      for (const attempt of attempts) {
        result = await attempt().catch(() => null);
        if (result) break;
      }
      result = result
        || { status: 'error', ticker, side, qty, reason: 'No broker connected. Connect Alpaca (one click) or ask an admin to set Alpaca paper keys to trade.' };
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
      } else if (result && result.status === 'dry_run') {
        // Blocked by the safety gate (TRADER_LIVE off / caps / kill-switch): a
        // successful DRY run, not an error — the UI shows "paper/blocked — why".
        sendJson(res, result, 200);
      } else {
        sendJson(res, result || { status: 'error', error: 'Unknown error' }, 400);
      }
    } catch (error) {
      sendJson(res, { status: 'error', error: error.message }, 500);
    }
    return true;
  }

  return false;
};
