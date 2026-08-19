/**
 * Trading routes — orders group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

// SESSION STATE, ET (#3326). Manual orders were built as plain MARKET orders,
// which simply do not execute outside regular hours — IBKR needs a LIMIT with
// outsideRth. The ENGINE has known this since 2026-08-12 (its extended-hours
// exits are marketable limits at ±0.2% with outsideRth:true); the manual paths
// never learned it, so every operator Flatten placed pre-market sat until the
// 09:30 auction, and the dust probe's "accepted" order went Inactive at the
// broker instead of working. Same order, different fate, purely because a human
// pressed the button.
//   rth      weekday 09:30-16:00 — market orders are fine
//   extended weekday 04:00-09:30 / 16:00-20:00 — LMT + outsideRth required
//   closed   otherwise — nothing executes; the order queues to the next session
function _sessionState(now = Date.now()) {
  const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = d.getDay();
  const min = d.getHours() * 60 + d.getMinutes();
  if (dow < 1 || dow > 5) return 'closed';
  if (min >= 570 && min < 960) return 'rth';
  if (min >= 240 && min < 1200) return 'extended';
  return 'closed';
}

module.exports = async function ordersRoutes(req, res, url, ctx) {
  const { sendJson, collectRequestBody, bridge, traderAgent, tradingMemory, tradingStore, getEffectiveUserId } = ctx;


  // DELETE /api/trading/orders/:id — cancel ONE working order (user-testing gap
  // 2026-07-26: manual limit orders could be placed but never canceled — only
  // Kalshi had a cancel route). Cancels on the user's preferred broker; the
  // adapters only ever cancel orders belonging to the resolved account.
  if (req.method === 'DELETE') {
    const m = url.pathname.match(/^\/api\/trading\/orders\/([A-Za-z0-9-]{6,64})$/);
    if (m) {
      const uid = getEffectiveUserId(req);
      try {
        // Route by ORDER-ID SHAPE, not by broker preference: Alpaca ids are UUIDs,
        // IBKR ids are numeric. (First cut asked the preferred-broker facade, which
        // "canceled" an Alpaca order against IBKR and reported success — caught by
        // verifying the order state on the broker afterward.)
        const id = m[1];
        const isAlpacaId = /[a-f0-9]{8}-[a-f0-9]{4}/i.test(id);
        let ok = false; let broker = null; let cancelUid = null;
        // TRUTHY-OBJECT BUG (live 2026-08-14): bridge.cancelIBKROrder returns
        // { ok:false } when the account has no broker/session — an OBJECT, which
        // this route treated as a boolean. {ok:false} is truthy, so a FAILED
        // own-account cancel reported success, the toast said "✓ Canceled", the
        // operator fallback never ran, and the duplicate SPXS kept resting at
        // IBKR. Every result is now normalized through okOf().
        const okOf = (r) => r === true || !!(r && r.ok === true);
        const tryAlpaca = async (u) => {
          const alpaca = require('../../lib/alpaca-adapter');
          return alpaca.available(u) ? okOf(await alpaca.cancelOrder(u, id).catch(() => false)) : false;
        };
        const tryIbkr = async (u) => (bridge && bridge.cancelIBKROrder
          ? okOf(await bridge.cancelIBKROrder(u, id).catch(() => false)) : false);
        if (isAlpacaId) { ok = await tryAlpaca(uid); broker = ok ? 'alpaca' : null; }
        else { ok = await tryIbkr(uid); broker = ok ? 'ibkr' : null; }
        if (!ok) { // cross-broker fallback, tried honestly
          ok = isAlpacaId ? await tryIbkr(uid) : await tryAlpaca(uid);
          if (ok) broker = isAlpacaId ? 'ibkr' : 'alpaca';
        }
        if (ok) cancelUid = uid;
        // ADMIN OPERATOR-VIEW CANCEL FALLBACK (2026-08-14). The operator-view
        // Orders tab lists the operator book's orders; its cancel button must be
        // able to cancel them, or the tab shows a duplicate sell it cannot act
        // on. Same admin-only pattern as placement; the adapters still refuse
        // ids that do not belong to the resolved account.
        if (!ok) {
          try {
            const isAdminFn = (ctx && ctx.isAdmin) || require('../../lib/auth-middleware').isAdmin;
            const OPERATOR_UID = process.env.TRADER_OPERATOR_UID || 'local-owner';
            if (isAdminFn(req) && uid !== OPERATOR_UID) {
              ok = await tryIbkr(OPERATOR_UID);
              if (ok) broker = 'ibkr-operator';
              else {
                ok = await tryAlpaca(OPERATOR_UID);
                if (ok) broker = 'alpaca-operator';
              }
              if (ok) cancelUid = OPERATOR_UID;
            }
          } catch (_e) { /* auth module absent → no fallback */ }
        }
        // VERIFY, don't trust (this route's own history: a cancel once "succeeded"
        // against the wrong broker, "caught by verifying the order state on the
        // broker afterward" — and today's truthy-object bug produced the same
        // false toast by another road). A cancel only counts when the order is
        // no longer WORKING on the account that canceled it. One retry covers
        // IBKR's cancel-acknowledgement lag.
        let verified = null;
        if (ok && broker && /ibkr/.test(broker) && bridge && bridge.getIBKROpenOrders) {
          const stillWorking = async () => {
            const open = await bridge.getIBKROpenOrders(cancelUid).catch(() => null);
            if (!Array.isArray(open)) return null;           // unreadable → unknown
            const row = open.find((o) => String(o && o.orderId) === String(id));
            return !!(row && /submit|presubmit|pending(?!cancel)|open|accepted|new|working|held/i.test(String(row.status || '')));
          };
          let w = await stillWorking();
          if (w === true) { await new Promise((r2) => setTimeout(r2, 700)); w = await stillWorking(); }
          verified = w === null ? null : !w;
          if (verified === false) {
            sendJson(res, { ok: false, error: 'cancel_not_confirmed', order_id: id, broker, detail: 'the broker accepted the cancel request but the order is still working — check the Orders tab and retry' }, 502);
            return true;
          }
        }
        sendJson(res, ok ? { ok: true, canceled: id, broker, ...(verified === null ? {} : { verified }) } : { ok: false, error: 'cancel_failed', order_id: id }, ok ? 200 : 502);
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
  }

  // POST /api/trading/orders/dust-clear  { ticker }
  //
  // THE DUST PROBE (#3325). A sub-1-share remnant cannot be closed through the
  // normal path: the bridge floors every quantity, so floor(0.8)=0 and the exit
  // is unexpressible. That floor was inferred from 2026-07-28 (a 838.8 sell the
  // broker cancelled 28 times) and has been treated as settled fact ever since —
  // but the SAME ledger shows the account HOLDING fractional size, so fractional
  // fills reached it somehow (paper-engine fill, or a corporate action; SOXS has
  // reverse-split history). The floor makes that claim untestable by
  // construction. This endpoint sends the EXACT held quantity, unfloored, and
  // reports the broker's verdict verbatim — a measurement, not a workaround.
  //
  // Deliberately NOT a flag on /orders/place: this is the only way to set
  // allowFractional, and it is boxed in on every side —
  //   • SELL only, and only the position's own quantity (no caller-supplied qty)
  //   • sub-1-share ONLY: >=1 is refused, so it can never become a general
  //     fractional-order path or touch a real position
  //   • verified against the live book first — no position, no order
  //   • admin only, operator-driven; the engine never calls it
  // Whatever IBKR answers is recorded either way, so the constraint stops being
  // folklore and becomes evidence.
  if (url.pathname === '/api/trading/orders/dust-clear' && req.method === 'POST') {
    try {
      const isAdminFn = (ctx && ctx.isAdmin) || require('../../lib/auth-middleware').isAdmin;
      if (!isAdminFn(req)) { sendJson(res, { ok: false, error: 'admin_only' }, 403); return true; }
      const body = await collectRequestBody(req);
      const { ticker } = body ? JSON.parse(body) : {};
      if (!ticker) { sendJson(res, { ok: false, error: 'ticker required' }, 400); return true; }
      const sym = String(ticker).toUpperCase();

      // Resolve the holding on the account that actually owns it (admin → operator).
      const uid = getEffectiveUserId(req);
      const OPERATOR_UID = process.env.TRADER_OPERATOR_UID || 'local-owner';
      let acct = uid;
      let pos = (await bridge.getIBKRPositions(uid).catch(() => null)) || [];
      let row = Array.isArray(pos) ? pos.find((p) => String(p && p.symbol).toUpperCase() === sym) : null;
      if (!row && uid !== OPERATOR_UID) {
        pos = (await bridge.getIBKRPositions(OPERATOR_UID).catch(() => null)) || [];
        row = Array.isArray(pos) ? pos.find((p) => String(p && p.symbol).toUpperCase() === sym) : null;
        if (row) acct = OPERATOR_UID;
      }
      if (!row) { sendJson(res, { ok: false, error: 'not_held', ticker: sym }, 404); return true; }

      const held = Math.abs(Number(row.qty) || 0);
      if (!(held > 0)) { sendJson(res, { ok: false, error: 'not_held', ticker: sym }, 404); return true; }
      if (held >= 1) {
        sendJson(res, { ok: false, error: 'not_dust', ticker: sym, held,
          detail: 'this endpoint only ever sends sub-1-share remnants — use Flatten for a real position' }, 400);
        return true;
      }

      // Same extended-hours conversion as /orders/place (#3326): the first probe
      // returned "accepted" and then sat Inactive at the broker, because a market
      // order outside RTH does not work. Price a marketable limit when we can.
      const _dSess = _sessionState();
      const _dOrder = { ticker: sym, side: 'sell', qty: held, type: 'market',
        acceptWarnings: true,        // risk-reducing by construction
        allowFractional: true };     // THE probe: unfloored
      let _dNote = null;
      if (_dSess !== 'rth') {
        let px = 0;
        try {
          const q = await require('../../lib/market-data-yahoo').getQuotes([sym]);
          px = Number(q && q[0] && q[0].price) || 0;
        } catch (_e) { /* fall through to market */ }
        if (px > 0 && _dSess === 'extended') {
          _dOrder.type = 'limit';
          _dOrder.limitPrice = Math.round(px * 0.998 * 100) / 100;
          _dOrder.outsideRth = true;
          _dNote = `extended hours: marketable limit @ ${_dOrder.limitPrice} with outsideRth`;
        } else if (px > 0) {
          // CLOSED MARKET NEEDS GTC (#3327). The previous note claimed the order
          // "QUEUES until the next session" — it did not. The bridge defaults
          // non-STP orders to TIF=DAY, and a DAY order placed on a day with no
          // session EXPIRES at that day's end rather than surviving to the next
          // open. Live proof: the 0.8-share SOXS dust order was accepted Saturday,
          // reported as queued, and by Monday 11:38 the position was untouched
          // with no order anywhere. A marketable GTC limit genuinely survives the
          // weekend and executes at the open.
          _dOrder.type = 'limit';
          _dOrder.limitPrice = Math.round(px * 0.98 * 100) / 100;   // deeply marketable: fills at the open print
          _dOrder.timeInForce = 'gtc';
          _dNote = `market closed: GTC limit @ ${_dOrder.limitPrice} — rests until the next open and fills there (a DAY order would expire unfilled)`;
        } else {
          _dNote = 'market closed and no quote available to price a resting order — try again during market hours';
        }
      }
      const r = await bridge.placeIBKROrder(acct, _dOrder)
        .catch((e) => ({ status: 'error', reason: e.message }));

      const placed = !!(r && r.status === 'placed');
      // Recorded either way — the point is the evidence, not the fill.
      try {
        require('../../lib/trading-store').appendLogEntry({
          ts: new Date().toISOString(), kind: 'dust_clear_probe', symbol: sym, qty: held,
          account: acct === OPERATOR_UID ? 'operator' : 'self',
          result: r && r.status, reason: (r && (r.reason || r.error)) || null,
        });
      } catch (_e) { /* logging must never break the probe */ }

      // Record it like any other order, so it appears in the Orders tab instead
      // of vanishing — the first probe was accepted by the broker and then had
      // no row anywhere, which is indistinguishable from "nothing happened".
      if (placed && r.order_id) {
        try {
          await tradingMemory.recordNewOrders([{
            id: r.order_id, symbol: sym, side: 'sell', qty: held,
            status: 'submitted', order_type: _dOrder.type,
          }]);
        } catch (_e) { /* the order is placed; bookkeeping must not fail it */ }
      }
      sendJson(res, {
        ok: placed, ticker: sym, qty: held, order_id: (r && r.order_id) || null,
        broker_status: (r && r.status) || null,
        broker_says: (r && (r.reason || r.error)) || null,   // verbatim — this IS the finding
        operator_account: acct === OPERATOR_UID && uid !== OPERATOR_UID,
        session: _dSess, session_note: _dNote,
      }, placed ? 200 : 502);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 500);
    }
    return true;
  }

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
      const uid = getEffectiveUserId(req);
      let orders = [];
      // Read orders from the SAME broker the Positions/account come from (else the
      // tabs show one account's orders next to another's balance). Resolve it the
      // same way market.js does — the user's preferred/active broker.
      const { preferredBroker } = require('../../lib/broker-facade');
      const pref = preferredBroker(uid, req);
      const alpaca = require('../../lib/alpaca-adapter');
      // Alpaca path: `status=all` so BOTH open orders AND filled/cancelled history
      // populate — the old handler only ever fetched IBKR *open* orders, which is why
      // Order history was always "None" on the Alpaca account.
      // Alpaca is the app's primary broker: show its order history whenever Alpaca is
      // usable and the user hasn't explicitly chosen IBKR (was `pref === 'alpaca'` only,
      // so an Alpaca-via-keys user on the default preference saw empty IBKR history).
      if (alpaca.available(uid) && pref !== 'ibkr') {
        const all = await alpaca.getAllOrders(uid, limitParam > 0 ? limitParam : 200).catch(() => []);
        if (Array.isArray(all) && all.length) { sendJson(res, all, 200); return true; }
      }
      // Prefer the connected IBKR account's own orders (working + filled) so the
      // Orders / Order-history tabs reflect the autopilot's trades — the legacy
      // agent/ledger only knew manual orders, so history showed "None".
      let ibkr = await bridge.getIBKROpenOrders(uid).catch(() => null);
      // ADMIN OPERATOR-VIEW READ FALLBACK (2026-08-14). Account, positions and
      // PLACEMENT all fall back to the operator book for an admin with no linked
      // broker — this read never did. Live consequence at 04:50: the operator's
      // four flatten sells (including a DUPLICATE SPXS the resting-sell guard
      // exists to catch) were resting at IBKR, and the Orders tab said "None" —
      // the one screen that could cancel the duplicate showed nothing to cancel.
      let _opView = false;
      if (!(Array.isArray(ibkr) && ibkr.length)) {
        try {
          const isAdminFn = (ctx && ctx.isAdmin) || require('../../lib/auth-middleware').isAdmin;
          const OPERATOR_UID = process.env.TRADER_OPERATOR_UID || 'local-owner';
          if (isAdminFn(req) && uid !== OPERATOR_UID) {
            const op = await bridge.getIBKROpenOrders(OPERATOR_UID).catch(() => null);
            if (Array.isArray(op) && op.length) { ibkr = op; _opView = true; }
          }
        } catch (_e) { /* auth module absent → no fallback */ }
      }
      if (Array.isArray(ibkr) && ibkr.length) {
        const norm = (s) => {
          const x = String(s || '').toLowerCase();
          if (/fill/.test(x)) return 'filled';
          if (/cancel/.test(x)) return 'canceled';
          // 'Inactive' is NOT working: IBKR parks an order there when it was never
          // transmitted (e.g. it hit the order-warning gate and nothing confirmed it).
          // Mapping it to 'open' made 972 inert orders look like live resting orders —
          // it fooled a human reviewer into reporting a 25x oversell exposure that did
          // not exist, and it is unactionable (cancel returns 'Order is inactive').
          if (/inactive/.test(x)) return 'inactive';
          if (/submit|presubmit|pending/.test(x)) return 'open';
          return x || 'unknown';
        };
        const tstr = (t) => { const n = Number(t); return n > 1e11 ? new Date(n).toISOString() : (t || ''); };
        orders = ibkr.map((o) => ({
          id: o.orderId, symbol: o.symbol, side: String(o.side || '').toLowerCase(),
          qty: o.qty, type: String(o.orderType || 'market').toLowerCase(),
          limit_price: o.orderType === 'STP' || o.orderType === 'LMT' ? o.price : null,
          status: norm(o.status), filled_avg_price: o.avgPrice || 0,
          filled_at: tstr(o.time), created_at: tstr(o.time),
          // Flagged like the account/positions fallback, so the UI can never
          // silently present the operator book as the viewer's own orders.
          ...(_opView ? { operator_account: true } : {}),
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
    // NOTE: no `traderAgent` gate here — placement goes straight to the broker
    // (alpaca-adapter / IBKR bridge) below, so an Alpaca user can trade even when the
    // legacy IBKR-era TraderAgent isn't initialized. Broker availability is handled by
    // the attempt loop + "no broker connected" fallback.
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const { ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit } = payload;
      if (!ticker || !['buy', 'sell'].includes(String(side || '').toLowerCase()) || !qty || Number(qty) <= 0) {
        sendJson(res, { status: 'error', error: 'ticker, side (buy/sell), and positive qty are required' }, 400);
        return true;
      }
      // acceptWarnings (2026-08-14): IBKR raises disclosure/size warnings and the
      // manual Flatten path dead-ended on them — the bridge supports the flag but
      // this route never forwarded it, so the operator could not trim the 3x carry
      // ("Couldn't flatten SOXS: re-submit with acceptWarnings:true").
      // SELLS ONLY, always: a buy that draws warnings must keep surfacing them
      // (P0-8), whether the engine or a person is driving.
      const _isSell = String(side).toLowerCase() === 'sell';
      let acceptWarnings = payload.acceptWarnings === true && _isSell;
      let _autoAccepted = null;
      // VERIFIED RISK-REDUCING SELLS AUTO-ACCEPT (2026-08-14, second pass). The
      // first fix bounced every warned sell to a confirm popup, and the popup was
      // asking the human to approve "IBKR returned order warnings" — no content,
      // pure friction (operator: "i dont like this popup"). The engine's own
      // exits already auto-accept (2026-07-27, after 13 stalled exits, one run to
      // -18.9% waiting for a click); what that decision actually requires is not
      // a human, it is PROOF the sell reduces risk. The engine proves it by
      // reconciling qty to the held position — so this route now does the same:
      // verify against the live book that qty <= |held|, and only then accept.
      // Oversell stays impossible to auto-clear: unverifiable (feed down, symbol
      // not held, qty too big) falls back to the explicit human confirm.
      const _sellRiskReducing = async (uidX) => {
        try {
          const pos = await bridge.getIBKRPositions(uidX);
          if (!Array.isArray(pos)) return false;
          const p = pos.find((x) => String(x && x.symbol).toUpperCase() === String(ticker).toUpperCase());
          const held = Math.abs(Number(p && p.qty) || 0);
          if (held < 1) return false;
          // RESTING SELLS COUNT AGAINST THE POSITION (live 2026-08-14 04:34).
          // The operator flattened SPXS, the position list did not update
          // (pre-market market orders REST until the auction), so they clicked
          // again — and this check re-verified against the unchanged position
          // and auto-accepted a DUPLICATE 2,467-share sell: an oversell in two
          // installments. The engine's own exit path has exactly this guard
          // (its workingSells set); the manual path now has it too. Protective
          // STOPS deliberately do not count: every position always carries one,
          // and counting it would make every flatten unverifiable.
          let resting = 0;
          const open = await bridge.getIBKROpenOrders(uidX);
          for (const o of (Array.isArray(open) ? open : [])) {
            if (String(o && o.symbol).toUpperCase() !== String(ticker).toUpperCase()) continue;
            if (!/sell/i.test(o.side || '')) continue;
            if (/stp|stop/i.test(o.orderType || o.type || '')) continue;
            if (!/submit|pending|presubmit|open|accepted|new|working|held/i.test(o.status || '')) continue;
            resting += Number(o.qty) || 0;
          }
          const available = Math.floor(held) - resting;
          // FLOOR THE REQUEST TOO (same morning): the UI sends the position's
          // raw fractional qty (SOXS 3057.8); the bridge floors it before
          // placing, so verification must judge the sell that will actually be
          // sent — floor(3057.8)=3057 against 3057 available is risk-reducing.
          const wanted = Math.floor(Number(qty));
          return wanted >= 1 && wanted <= available;
        } catch (_e) { return false; }   // cannot verify -> cannot auto-accept
      };
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
      if (_isSell && !acceptWarnings && await _sellRiskReducing(uid)) {
        acceptWarnings = true;
        _autoAccepted = 'risk_reducing_sell';
      }
      const orderReq = { ticker, side, qty, type, limitPrice, timeInForce, stopLoss, takeProfit, acceptWarnings };
      // EXTENDED-HOURS CONVERSION (#3326). A MARKET order does not execute
      // outside RTH, so a manual Flatten placed pre-market just sat there — the
      // operator saw "✓ Flattened" and a position that never left. The engine
      // already converts (marketable LMT + outsideRth); do the same here so a
      // human's order behaves like the engine's. Marketable = cross the spread
      // by 0.2% in the direction of the trade, matching auto-trader's constant.
      let _sessionNote = null;
      const _sess = _sessionState();
      if (_sess !== 'rth' && String(type || 'market').toLowerCase() === 'market') {
        let px = 0;
        try {
          const q = await require('../../lib/market-data-yahoo').getQuotes([ticker]);
          px = Number(q && q[0] && q[0].price) || 0;
        } catch (_e) { /* no quote → cannot price a limit */ }
        if (px > 0 && _sess === 'extended') {
          const isBuy = String(side).toLowerCase() === 'buy';
          orderReq.type = 'limit';
          orderReq.limitPrice = Math.round(px * (isBuy ? 1.002 : 0.998) * 100) / 100;
          orderReq.outsideRth = true;
          _sessionNote = `extended hours: sent as a marketable limit @ ${orderReq.limitPrice} with outsideRth (a market order would not execute until 09:30)`;
        } else if (_sess === 'closed') {
          // Same DAY-expiry trap as the dust path (#3327): "queues" was false —
          // TIF=DAY on a closed day expires unfilled. Make it genuinely rest.
          if (px > 0) {
            const isBuy = String(side).toLowerCase() === 'buy';
            orderReq.type = 'limit';
            orderReq.limitPrice = Math.round(px * (isBuy ? 1.02 : 0.98) * 100) / 100;
            orderReq.timeInForce = 'gtc';
            _sessionNote = `market closed: GTC limit @ ${orderReq.limitPrice} — rests until the next open and fills there (a DAY order would expire unfilled)`;
          } else {
            _sessionNote = 'market closed and no quote available to price a resting order — this order may expire unfilled; place it during market hours';
          }
        } else {
          _sessionNote = 'extended hours: no quote available to price a limit — sent as market, which will not fill until 09:30';
        }
      }
      const alpaca = require('../../lib/alpaca-adapter');
      const { preferredBroker } = require('../../lib/broker-facade');
      // Broker precedence: connected IBKR → Alpaca (the user's own OAuth account,
      // else the operator's server paper keys), flipped by BROKER_PREFER=alpaca.
      // Either order keeps the other broker as fallback. Alpaca PAPER fills for
      // real without arming — so a paper trade actually happens instead of a
      // dry-run dead end.
      // Alpaca is the primary broker: try it first whenever it's usable, unless the
      // user explicitly prefers IBKR. (Was hard IBKR-first by default.)
      const alpacaFirst = preferredBroker(uid, req) !== 'ibkr' && alpaca.available(uid);
      const attempts = alpacaFirst
        ? [() => alpaca.placeOrder(uid, orderReq), () => bridge.placeIBKROrder(uid, orderReq)]
        : [() => bridge.placeIBKROrder(uid, orderReq), () => alpaca.placeOrder(uid, orderReq)];
      // The FIRST connected broker to answer wins — its result (placed / dry_run / or a
      // real error like "insufficient shares") is surfaced as-is. We only fall through
      // to the next broker when one returns null = NOT CONNECTED. Crucially we do NOT
      // re-route a user's order to a broker they didn't choose just because their chosen
      // broker returned an error — that would silently place the trade on the wrong
      // account. The old default-IBKR-first ordering caused Alpaca users to hit IBKR
      // errors; `alpacaFirst` above fixes that by trying the intended broker first.
      let result = null;
      for (const attempt of attempts) {
        result = await attempt().catch(() => null);
        if (result) break;                                  // connected broker answered → done
      }
      // ADMIN OPERATOR-VIEW WRITE FALLBACK (2026-08-10). The dashboard's READ
      // fallback shows an admin with no linked broker the operator book — but
      // Flatten then failed "No broker connected" because this write path only
      // resolved the admin's own (empty) uid. Mirror the read fallback: an
      // ADMIN acting from the operator view acts on the operator account,
      // flagged in the result so the UI can say whose account traded.
      // Admin-only; non-admins keep the exact old behavior.
      if (!result) {
        try {
          const { isAdmin } = require('../../lib/auth-middleware');
          const OPERATOR_UID = process.env.TRADER_OPERATOR_UID || 'local-owner';
          if (isAdmin(req) && uid !== OPERATOR_UID) {
            // The order is going to the OPERATOR book, so the risk-reducing
            // verification must be re-run against that book, not the admin's own
            // (empty) account — otherwise operator-view flattens keep the popup.
            const opReq = { ...orderReq };
            if (_isSell && !opReq.acceptWarnings && await _sellRiskReducing(OPERATOR_UID)) {
              opReq.acceptWarnings = true;
              _autoAccepted = 'risk_reducing_sell';
            }
            for (const attempt of [() => bridge.placeIBKROrder(OPERATOR_UID, opReq), () => alpaca.placeOrder(OPERATOR_UID, opReq)]) {
              result = await attempt().catch(() => null);
              if (result) { result.operator_account = true; break; }
            }
          }
        } catch (_e) { /* auth module absent → no fallback */ }
      }
      result = result
        || { status: 'error', ticker, side, qty, reason: 'No broker connected. Add your Alpaca API keys in Settings → Connections to trade.' };
      // Transparency: when warnings were cleared by position-verification rather
      // than a human, the response says so — the journal and any audit can tell
      // the two apart.
      if (_autoAccepted) result.auto_warnings = _autoAccepted;
      // The session caveat rides on the response so the toast can tell the truth
      // about WHEN this order will act — "placed" and "will fill" are different
      // claims, and conflating them is what made a pre-market Flatten look done.
      if (_sessionNote) { result.session = _sess; result.session_note = _sessionNote; }
      if (result && result.status === 'placed') {
        await tradingMemory.recordNewOrders([{
          id: result.order_id,
          symbol: result.ticker,
          side: result.side,
          qty: result.qty,
          status: 'submitted',
          order_type: result.type,
        }]);
        // #2547: the composite active-user metric needs a per-user paper-trade
        // artifact. Record it as a MEASURED traction event at the moment a real
        // broker accepted the order (verified:true — machine-checked, not
        // self-reported). Best-effort: metrics must never break order placement.
        if (uid) {
          require('../../lib/traction').recordTractionEvent({
            kind: 'paper_trade',
            actor: String(uid),
            verified: true,
            confidence: 'high',
            source: 'POST /api/trading/orders/place',
            evidence: { order_id: result.order_id, symbol: result.ticker, side: result.side, qty: result.qty },
          }).catch(() => {});
        }
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
