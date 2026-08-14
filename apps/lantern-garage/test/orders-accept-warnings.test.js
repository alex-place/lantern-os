'use strict';

/**
 * orders-accept-warnings.test.js — the manual Flatten path can confirm IBKR
 * warnings, and only where that is safe.
 *
 * Live 2026-08-14 (pre-open): the operator tried to trim the 3x carry and the
 * Flatten button dead-ended — "Couldn't flatten SOXS: IBKR returned order
 * warnings; re-submit with acceptWarnings:true". The bridge has supported the
 * flag since 2026-07-27 (risk-reducing sells accept warnings; that decision was
 * paid for by 13 stalled exits, one of which ran to -18.9%), but this route
 * never forwarded it, so no UI resubmit could work.
 *
 * The boundary being pinned:
 *   - SELL + explicit acceptWarnings:true  → forwarded (human confirmed the text)
 *   - BUY  + acceptWarnings:true           → STRIPPED. Entries surface warnings,
 *     always (P0-8). A buy that needs warning-clicking is a buy a human reviews.
 *   - absent → false. Never defaulted on: this endpoint takes arbitrary user
 *     qty, and an auto-accepted oversell warning would blow through flat into a
 *     short.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ordersRoutes = require('../routes/trading/orders');

async function drive(payload) {
  const captured = { orderReq: null, response: null, code: null };
  const ctx = {
    sendJson: (_res, body, code) => { captured.response = body; captured.code = code; },
    collectRequestBody: async () => JSON.stringify(payload),
    bridge: {
      placeIBKROrder: async (_uid, orderReq) => { captured.orderReq = orderReq; return { status: 'error', error: 'stub' }; },
    },
    traderAgent: null,
    tradingMemory: { recordNewOrders: async () => {} },
    tradingStore: {},
    getEffectiveUserId: () => 'test-user',
  };
  const req = { method: 'POST', headers: {}, socket: {} };
  const url = new URL('http://127.0.0.1/api/trading/orders/place');
  const handled = await ordersRoutes(req, {}, url, ctx);
  assert.strictEqual(handled, true, 'route must claim the request');
  return captured;
}

test('SELL with explicit acceptWarnings:true forwards it to the broker bridge', async () => {
  const c = await drive({ ticker: 'SOXS', side: 'sell', qty: 3057, type: 'market', acceptWarnings: true });
  assert.ok(c.orderReq, 'bridge was called');
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'the confirmed resubmit must carry the flag');
});

test('BUY with acceptWarnings:true is STRIPPED — entries always surface warnings (P0-8)', async () => {
  const c = await drive({ ticker: 'SOXS', side: 'buy', qty: 100, type: 'market', acceptWarnings: true });
  assert.ok(c.orderReq, 'bridge was called');
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'a warned BUY must dead-end at the human, never auto-clear');
});

test('absent flag defaults to false — first attempts never accept silently', async () => {
  const c = await drive({ ticker: 'GLD', side: 'sell', qty: 10, type: 'market' });
  assert.ok(c.orderReq, 'bridge was called');
  assert.strictEqual(c.orderReq.acceptWarnings, false);
});

test('non-boolean truthy values do not sneak through (strict === true)', async () => {
  const c = await drive({ ticker: 'GLD', side: 'sell', qty: 10, type: 'market', acceptWarnings: 'yes' });
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'only an explicit boolean true counts as a human confirm');
});
