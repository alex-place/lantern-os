'use strict';

/**
 * dust-clear-probe.test.js — the sub-share remnant gets ONE unfloored attempt,
 * and the broker's answer is recorded either way (#3325).
 *
 * The bridge floors every quantity, so floor(0.8)=0 and a dust exit cannot be
 * expressed at all. That floor was inferred from 2026-07-28 (a 838.8 sell the
 * broker cancelled 28 times) — but the same ledger shows the account HOLDING
 * fractional size, so fractional fills reached it somehow. The floor made the
 * claim untestable; this endpoint measures it.
 *
 * The box around allowFractional is the point of these tests: it is reachable
 * ONLY here, only for SELLs, only sub-1-share, only for a verified holding,
 * only for an admin, and never with a caller-supplied quantity.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ordersRoutes = require('../routes/trading/orders');

process.env.TRADER_OPERATOR_UID = 'op-1';

function ctxFor({ admin = true, positions = {}, place } = {}, cap) {
  return {
    sendJson: (_res, body, code) => { cap.body = body; cap.code = code; },
    collectRequestBody: async () => JSON.stringify({ ticker: 'SOXS' }),
    isAdmin: () => admin,
    bridge: {
      getIBKRPositions: async (uid) => positions[uid] || [],
      placeIBKROrder: async (uid, o) => { cap.order = { uid, ...o }; return place || { status: 'placed', order_id: 'D1' }; },
      getIBKROpenOrders: async () => [],
    },
    traderAgent: null,
    tradingMemory: { recordNewOrders: async () => {} },
    tradingStore: { listOrders: () => [] },
    getEffectiveUserId: () => 'admin-user',
  };
}

async function drive(opts) {
  const cap = { body: null, code: null, order: null };
  const handled = await ordersRoutes(
    { method: 'POST', headers: {}, socket: {} }, {},
    new URL('http://127.0.0.1/api/trading/orders/dust-clear'), ctxFor(opts, cap),
  );
  assert.strictEqual(handled, true, 'route must claim the request');
  return cap;
}

test('the live shape: 0.8 SOXS is sent UNFLOORED, as a sell, with allowFractional', async () => {
  const c = await drive({ positions: { 'admin-user': [{ symbol: 'SOXS', qty: 0.8 }] } });
  assert.ok(c.order, 'an order was attempted');
  assert.strictEqual(c.order.qty, 0.8, 'the EXACT held quantity — flooring is what made this impossible');
  assert.strictEqual(c.order.side, 'sell');
  assert.strictEqual(c.order.allowFractional, true);
  assert.strictEqual(c.order.acceptWarnings, true, 'risk-reducing by construction');
  assert.strictEqual(c.body.ok, true);
});

test('a REJECTION is reported verbatim and is still a valid outcome (200 -> 502, no hiding)', async () => {
  const c = await drive({
    positions: { 'admin-user': [{ symbol: 'SOXS', qty: 0.8 }] },
    place: { status: 'error', reason: 'IBKR cancelled: fractional not supported on this account' },
  });
  assert.strictEqual(c.code, 502);
  assert.strictEqual(c.body.ok, false);
  assert.match(c.body.broker_says, /fractional not supported/, 'the broker\'s own words ARE the finding');
});

test('a REAL position is refused — this can never become a general fractional path', async () => {
  const c = await drive({ positions: { 'admin-user': [{ symbol: 'SOXS', qty: 1.8 }] } });
  assert.strictEqual(c.body.error, 'not_dust');
  assert.strictEqual(c.order, null, 'no order attempted at all');
});

test('a whole-share position is refused too (qty 100)', async () => {
  const c = await drive({ positions: { 'admin-user': [{ symbol: 'SOXS', qty: 100 }] } });
  assert.strictEqual(c.body.error, 'not_dust');
  assert.strictEqual(c.order, null);
});

test('not held → no order (quantity is never caller-supplied)', async () => {
  const c = await drive({ positions: { 'admin-user': [{ symbol: 'GLD', qty: 0.5 }] } });
  assert.strictEqual(c.code, 404);
  assert.strictEqual(c.body.error, 'not_held');
  assert.strictEqual(c.order, null);
});

test('non-admin cannot reach the only allowFractional path in the codebase', async () => {
  const c = await drive({ admin: false, positions: { 'admin-user': [{ symbol: 'SOXS', qty: 0.8 }] } });
  assert.strictEqual(c.code, 403);
  assert.strictEqual(c.order, null);
});

test('operator-view: dust on the operator book is cleared on THAT account, flagged', async () => {
  const c = await drive({ positions: { 'admin-user': [], 'op-1': [{ symbol: 'SOXS', qty: 0.8 }] } });
  assert.strictEqual(c.order.uid, 'op-1', 'the order goes to the account that holds it');
  assert.strictEqual(c.body.operator_account, true);
});
