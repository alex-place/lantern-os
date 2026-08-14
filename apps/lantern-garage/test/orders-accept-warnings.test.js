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

async function drive(payload, { positions, openOrders } = {}) {
  const captured = { orderReq: null, response: null, code: null };
  const ctx = {
    sendJson: (_res, body, code) => { captured.response = body; captured.code = code; },
    collectRequestBody: async () => JSON.stringify(payload),
    bridge: {
      placeIBKROrder: async (_uid, orderReq) => { captured.orderReq = orderReq; return { status: 'error', error: 'stub' }; },
      // absent option → feed unreadable (throws), the conservative default
      getIBKRPositions: async () => { if (positions === undefined) throw new Error('feed down'); return positions; },
      getIBKROpenOrders: async () => (openOrders === undefined ? [] : openOrders),
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

// ── the two 04:34 live failures (2026-08-14, the operator's pre-open trim) ───

test('FRACTIONAL FLATTEN: selling the raw 3057.8 against 3057.8 held auto-accepts (both floor)', async () => {
  // The UI sends the position's raw qty; the bridge floors it before placing.
  // Verification judged the UNfloored request (3057.8 ≤ 3057 → false) and
  // bounced the operator's SOXS flatten to the popup for no reason.
  const c = await drive(
    { ticker: 'SOXS', side: 'sell', qty: 3057.8, type: 'market' },
    { positions: [{ symbol: 'SOXS', qty: 3057.8 }] },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'the sell that will actually be sent is floor(3057.8)=3057, fully covered');
});

test('A RESTING SELL COUNTS: the second identical flatten must NOT auto-accept', async () => {
  // Pre-market market orders REST until the auction, so the position list does
  // not update. The operator clicked Flatten SPXS twice; the second submit was
  // auto-accepted against the unchanged position — a 2,467-share oversell in
  // two installments (order ids 1765890034/35, live).
  const c = await drive(
    { ticker: 'SPXS', side: 'sell', qty: 2467, type: 'market' },
    {
      positions: [{ symbol: 'SPXS', qty: 2467 }],
      openOrders: [{ symbol: 'SPXS', side: 'SELL', qty: 2467, orderType: 'Market', status: 'Submitted' }],
    },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, false, 'held 2467 minus resting 2467 leaves nothing to cover a second sell');
});

test('a PARTIAL resting sell leaves the remainder auto-acceptable', async () => {
  const c = await drive(
    { ticker: 'SPXS', side: 'sell', qty: 1000, type: 'market' },
    {
      positions: [{ symbol: 'SPXS', qty: 2467 }],
      openOrders: [{ symbol: 'SPXS', side: 'SELL', qty: 1400, orderType: 'Limit', status: 'PreSubmitted' }],
    },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true, '2467 − 1400 resting = 1067 available covers 1000');
});

test('protective STOPS do not count against availability — every position carries one', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' },
    {
      positions: [{ symbol: 'SQQQ', qty: 1614 }],
      openOrders: [{ symbol: 'SQQQ', side: 'SELL', qty: 1614, orderType: 'Stop', status: 'PreSubmitted' }],
    },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'counting the stop would make every flatten unverifiable');
});

test('other symbols\' resting sells never bleed into availability', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' },
    {
      positions: [{ symbol: 'SQQQ', qty: 1614 }],
      openOrders: [{ symbol: 'SPXS', side: 'SELL', qty: 2467, orderType: 'Market', status: 'Submitted' }],
    },
  );
  assert.strictEqual(c.orderReq.acceptWarnings, true);
});

test('open-orders feed unreadable → cannot verify → no auto-accept (blind rule extends)', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' },
    {
      positions: [{ symbol: 'SQQQ', qty: 1614 }],
      openOrders: null,   // stub returns null → not an array
    },
  );
  // getIBKROpenOrders returning a non-array is treated as zero resting — but a
  // THROW must refuse. Drive the throw:
  const captured = { orderReq: null };
  const ctx = {
    sendJson: () => {},
    collectRequestBody: async () => JSON.stringify({ ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market' }),
    bridge: {
      placeIBKROrder: async (_u, o) => { captured.orderReq = o; return { status: 'error', error: 'stub' }; },
      getIBKRPositions: async () => [{ symbol: 'SQQQ', qty: 1614 }],
      getIBKROpenOrders: async () => { throw new Error('orders feed down'); },
    },
    traderAgent: null, tradingMemory: { recordNewOrders: async () => {} }, tradingStore: {},
    getEffectiveUserId: () => 'test-user',
  };
  await ordersRoutes({ method: 'POST', headers: {}, socket: {} }, {}, new URL('http://127.0.0.1/api/trading/orders/place'), ctx);
  assert.strictEqual(captured.orderReq.acceptWarnings, false, 'an unreadable orders feed is the dropout shape — human check stays');
  void c;
});
