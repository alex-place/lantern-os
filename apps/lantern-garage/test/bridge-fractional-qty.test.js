'use strict';

/**
 * bridge-fractional-qty.test.js — IBKR orders must never carry fractional qty.
 *
 * 2026-07-28: a 838.8-share SOXS take-profit was decided 4x and canceled by the
 * broker every time (28 canceled orders) while +44% ran to +50%. CPAPI rejects
 * fractional share orders, so the bridge floors and reports the dust.
 */
const test = require('node:test');
const assert = require('node:assert');
const TradingAPIBridge = require('../lib/trading-api-bridge');

function stubbedBridge(captured) {
  const b = new TradingAPIBridge();
  b.ibkrForUser = () => ({
    getStatus: async () => ({ connected: true, mode: 'paper', accountId: 'DUR0' }),
    placeOrder: async (o) => { captured.push(o); return { status: 'submitted', orderId: '1', order: o, gate: { allowed: true } }; },
  });
  return b;
}

test('fractional sell is floored to whole shares with the dust reported', async () => {
  const got = [];
  const r = await stubbedBridge(got).placeIBKROrder('u', { ticker: 'SOXS', side: 'sell', qty: 838.8, type: 'market', equity: 1000 });
  assert.strictEqual(got[0].qty, 838, 'broker must receive whole shares');
  assert.strictEqual(r.status, 'placed');
  assert.match(String(r.reason), /floored 838\.8 -> 838/);
});

test('a dust-only position (<1 share) errors clearly instead of looping', async () => {
  const got = [];
  const r = await stubbedBridge(got).placeIBKROrder('u', { ticker: 'SOXS', side: 'sell', qty: 0.8, type: 'market', equity: 1000 });
  assert.strictEqual(got.length, 0, 'nothing reaches the broker');
  assert.strictEqual(r.status, 'error');
  assert.match(String(r.reason), /fractional-only/);
});

test('integer quantities pass through untouched', async () => {
  const got = [];
  const r = await stubbedBridge(got).placeIBKROrder('u', { ticker: 'SPY', side: 'buy', qty: 5, type: 'market', equity: 1000 });
  assert.strictEqual(got[0].qty, 5);
  assert.strictEqual(r.status, 'placed');
  assert.strictEqual(r.reason, null);
});
