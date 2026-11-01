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

// 2026-10-26 (manual orders): the bridge forwards `manual` to the client only when the caller set it,
// hands IBKR's warning text back up, and a fresh positions read drops both caches first.
test('manual is forwarded only when the caller set it, and IBKR warnings come back to the caller', async () => {
  const got = [];
  const b = stubbedBridge(got);
  await b.placeIBKROrder('u', { ticker: 'XLE', side: 'buy', qty: 2628, type: 'market', equity: 963000, manual: true });
  await b.placeIBKROrder('u', { ticker: 'XLE', side: 'buy', qty: 10, type: 'market', equity: 963000 });
  assert.strictEqual(got[0].manual, true); assert.strictEqual(got[1].manual, false);
  const w = new TradingAPIBridge();
  w.ibkrForUser = () => ({
    getStatus: async () => ({ connected: true, mode: 'paper', accountId: 'DUR0' }),
    placeOrder: async () => ({ status: 'submitted', orderId: '9', warnings: [{ id: 'w1', message: 'The order size exceeds the Size Limit' }], gate: { allowed: true } }),
  });
  const r = await w.placeIBKROrder('u', { ticker: 'XLE', side: 'buy', qty: 10, type: 'market', equity: 963000 });
  assert.strictEqual(r.status, 'placed');
  assert.deepStrictEqual(r.warnings, [{ id: 'w1', message: 'The order size exceeds the Size Limit' }]);
});

test('the IBKR client hands the manual and reserve flags to the guard (source pin)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ibkr-cpapi.js'), 'utf8');
  assert.match(src, /const gate = orderGate\(\{ mode, qty, price, symbol, side, equity: eq, refPrice, manual: manual === true, reserve: reserve === true \}\);/);
});

test('a FRESH positions read invalidates the IBKR portfolio cache and skips the bridge cache', async () => {
  const calls = [];
  let n = 0;
  const b = new TradingAPIBridge();
  const client = {
    getStatus: async () => ({ connected: true, mode: 'paper', accountId: 'DUR0' }),
    invalidatePositions: async (id) => { calls.push('invalidate ' + id); return true; },
    getPositions: async () => { n += 1; calls.push('read'); return [{ symbol: 'XLE', qty: n === 1 ? -2628 : 2628 }]; },
  };
  b._clientFor = () => client; b.ibkrForUser = () => client; b._assertPinnedAccount = () => {};
  const first = await b.getIBKRPositions('u');                    // cached read
  const cached = await b.getIBKRPositions('u');                   // within 4 s: the cache answers
  const fresh = await b.getIBKRPositions('u', { fresh: true });   // invalidate + re-read
  assert.strictEqual(first[0].qty, -2628); assert.strictEqual(cached[0].qty, -2628);
  assert.strictEqual(fresh[0].qty, 2628, 'the fresh read sees the fill the cached one missed');
  assert.deepStrictEqual(calls, ['read', 'invalidate DUR0', 'read']);
});
