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

async function drive(payload, { positions } = {}) {
  const captured = { orderReq: null, response: null, code: null };
  const ctx = {
    sendJson: (_res, body, code) => { captured.response = body; captured.code = code; },
    collectRequestBody: async () => JSON.stringify(payload),
    bridge: {
      placeIBKROrder: async (_uid, orderReq) => { captured.orderReq = orderReq; return { status: 'error', error: 'stub' }; },
      // absent option → feed unreadable (throws), the conservative default
      getIBKRPositions: async () => { if (positions === undefined) throw new Error('feed down'); return positions; },
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

// ── verified risk-reducing sells auto-accept (2026-08-14 second pass) ────────
// The popup asked the human to approve "IBKR returned order warnings" — no
// content. What the 2026-07-27 exit policy actually requires is PROOF the sell
// reduces risk, and the server can prove that itself against the live book.

test('a sell covered by the held position auto-accepts — no popup, like engine exits', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' },
    { positions: [{ symbol: 'SQQQ', qty: 1614 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'qty <= held is verified risk-reducing');
  assert.strictEqual(c.response.auto_warnings, 'risk_reducing_sell', 'the response says the machine cleared it, not a human');
});

test('fractional book: SOXS 3057 sell against 3057.8 held auto-accepts (floored)', async () => {
  const c = await drive(
    { ticker: 'SOXS', side: 'sell', qty: 3057, type: 'market' },
    { positions: [{ symbol: 'SOXS', qty: 3057.8 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true);
});

test('an OVERSELL never auto-accepts — qty above the held size keeps the human check', async () => {
  const c = await drive(
    { ticker: 'GLD', side: 'sell', qty: 147, type: 'market' },
    { positions: [{ symbol: 'GLD', qty: 66 }] },        // the live 2026-08-13 shape
  );
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'selling 147 against 66 held would open a short');
  assert.strictEqual(c.response.auto_warnings, undefined);
});

test('a symbol not in the book never auto-accepts — that sell IS a short attempt', async () => {
  const c = await drive(
    { ticker: 'NVDA', side: 'sell', qty: 10, type: 'market' },
    { positions: [{ symbol: 'GLD', qty: 66 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, false);
});

test('positions feed unreadable → cannot verify → no auto-accept (never trade blind)', async () => {
  const c = await drive({ ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' });   // getIBKRPositions throws
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'the dropout case must fall back to the human');
});

test('a BUY never auto-accepts even when a position exists (P0-8 holds)', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'buy', qty: 10, type: 'market' },
    { positions: [{ symbol: 'SQQQ', qty: 1614 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, false);
});

test('dust cannot certify a sell: 0.8 held does not cover a 1-share sell', async () => {
  const c = await drive(
    { ticker: 'SOXS', side: 'sell', qty: 1, type: 'market' },
    { positions: [{ symbol: 'SOXS', qty: 0.8 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'held < 1 share cannot cover any whole-share sell');
});
