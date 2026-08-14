'use strict';

/**
 * orders-operator-view.test.js — the Orders tab must show (and be able to
 * cancel) the book the admin is actually looking at.
 *
 * Account, positions and order PLACEMENT all fall back to the operator book
 * for an admin with no linked broker (2026-08-10). The orders READ and CANCEL
 * never did. Live consequence, 2026-08-14 04:50: four flatten sells — one of
 * them a DUPLICATE 2,467-share SPXS the resting-sell guard exists to catch —
 * were resting at IBKR, and the Orders tab said "None". The one screen that
 * could cancel the duplicate had nothing to click.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ordersRoutes = require('../routes/trading/orders');

process.env.TRADER_OPERATOR_UID = 'op-1';

const OP_ORDERS = [
  { orderId: '1765890034', symbol: 'SPXS', side: 'SELL', qty: 2467, orderType: 'Market', status: 'Submitted', time: 1786690000000 },
  { orderId: '1765890035', symbol: 'SPXS', side: 'SELL', qty: 2467, orderType: 'Market', status: 'Submitted', time: 1786690001000 },
  { orderId: '99001', symbol: 'SQQQ', side: 'SELL', qty: 1614, orderType: 'STP', price: 34.84, status: 'PreSubmitted', time: 1786600000000 },
];

function ctxFor({ admin, ownOrders = [], opOrders = OP_ORDERS, cancels = {} } = {}, captured) {
  return {
    sendJson: (_res, body, code) => { captured.body = body; captured.code = code; },
    collectRequestBody: async () => '{}',
    isAdmin: () => admin,
    bridge: {
      getIBKROpenOrders: async (uid) => { captured.orderReads.push(uid); return uid === 'op-1' ? opOrders : ownOrders; },
      cancelIBKROrder: async (uid, id) => { captured.cancels.push(uid + ':' + id); return !!(cancels[uid] || {})[id]; },
    },
    traderAgent: null,
    tradingMemory: { recordNewOrders: async () => {} },
    tradingStore: { listOrders: () => [] },
    getEffectiveUserId: () => 'admin-user',
  };
}

async function driveGet(opts) {
  const captured = { body: null, code: null, orderReads: [], cancels: [] };
  const handled = await ordersRoutes(
    { method: 'GET', headers: {}, socket: {} }, {},
    new URL('http://127.0.0.1/api/trading/orders'), ctxFor(opts, captured),
  );
  assert.strictEqual(handled, true);
  return captured;
}

async function driveCancel(id, opts) {
  const captured = { body: null, code: null, orderReads: [], cancels: [] };
  const handled = await ordersRoutes(
    { method: 'DELETE', headers: {}, socket: {} }, {},
    new URL('http://127.0.0.1/api/trading/orders/' + id), ctxFor(opts, captured),
  );
  assert.strictEqual(handled, true);
  return captured;
}

test('ADMIN with an empty own book sees the operator orders, flagged', async () => {
  const c = await driveGet({ admin: true });
  assert.deepStrictEqual(c.orderReads, ['admin-user', 'op-1'], 'own book first, operator only as fallback');
  assert.strictEqual(c.body.length, 3, 'all operator orders listed — including the duplicate SPXS to cancel');
  for (const o of c.body) assert.strictEqual(o.operator_account, true, 'never silently presented as the viewer\'s own');
  const spxs = c.body.filter((o) => o.symbol === 'SPXS');
  assert.strictEqual(spxs.length, 2, 'the duplicate is VISIBLE — that is the whole point');
  assert.ok(c.body.every((o) => o.status === 'open'), 'Submitted/PreSubmitted normalize to open so the Orders tab shows them');
});

test('NON-admin with an empty book never reaches the operator orders', async () => {
  const c = await driveGet({ admin: false });
  assert.deepStrictEqual(c.orderReads, ['admin-user'], 'no operator read for a non-admin');
  assert.deepStrictEqual(c.body, [], 'empty means empty');
});

test('an admin whose OWN book has orders sees their own, unflagged — fallback only fills a void', async () => {
  const own = [{ orderId: '555', symbol: 'AAPL', side: 'BUY', qty: 1, orderType: 'Limit', price: 100, status: 'Submitted', time: 1786690002000 }];
  const c = await driveGet({ admin: true, ownOrders: own });
  assert.deepStrictEqual(c.orderReads, ['admin-user'], 'operator book not consulted');
  assert.strictEqual(c.body[0].symbol, 'AAPL');
  assert.strictEqual(c.body[0].operator_account, undefined);
});

test('ADMIN cancel falls through to the operator book and says whose account acted', async () => {
  const c = await driveCancel('1765890035', { admin: true, cancels: { 'op-1': { 1765890035: true } } });
  assert.strictEqual(c.body.ok, true);
  assert.strictEqual(c.body.broker, 'ibkr-operator', 'the response names the operator account');
  assert.ok(c.cancels.includes('admin-user:1765890035'), 'own account tried first');
  assert.ok(c.cancels.includes('op-1:1765890035'), 'then the operator book');
});

test('NON-admin cancel never touches the operator book — 502, honestly', async () => {
  const c = await driveCancel('1765890035', { admin: false, cancels: { 'op-1': { 1765890035: true } } });
  assert.strictEqual(c.code, 502);
  assert.strictEqual(c.body.ok, false);
  assert.ok(!c.cancels.includes('op-1:1765890035'), 'operator cancel must not be reachable without admin');
});
