'use strict';

/**
 * manual-extended-hours.test.js — a human's order behaves like the engine's
 * (#3326).
 *
 * Manual orders were plain MARKET orders. A market order does not execute
 * outside RTH, so every operator Flatten placed pre-market sat until the 09:30
 * auction while the toast said "✓ Flattened", and the dust probe's "accepted"
 * order went Inactive at the broker. The ENGINE has converted since 2026-08-12
 * (marketable LMT at ±0.2% with outsideRth); the manual paths never did — same
 * order, different fate, purely because a human pressed the button.
 *
 * Conversion is server-side so every manual path inherits it, and the response
 * carries a session note so the toast can distinguish PLACED from FILLED.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ordersRoutes = require('../routes/trading/orders');

// 2026-08-17 is a Monday. 13:00Z = 09:00 ET (pre-market), 15:00Z = 11:00 ET (RTH),
// 22:00Z = 18:00 ET (after-hours). 2026-08-16 is a Sunday.
const PRE = Date.parse('2026-08-17T13:00:00Z');
const RTH = Date.parse('2026-08-17T15:00:00Z');
const AFT = Date.parse('2026-08-17T22:00:00Z');
const SUN = Date.parse('2026-08-16T18:00:00Z');

function withClock(ms, fn) {
  const RealDate = Date;
  // Only `new Date()` (no args) and Date.now() are pinned; parsing must still work.
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(ms); }
    static now() { return ms; }
  };
  return Promise.resolve().then(fn).finally(() => { global.Date = RealDate; });
}

async function place(payload, { now, price = 100 } = {}) {
  const cap = { order: null, body: null };
  const ctx = {
    sendJson: (_r, b) => { cap.body = b; },
    collectRequestBody: async () => JSON.stringify(payload),
    isAdmin: () => true,
    bridge: {
      placeIBKROrder: async (_u, o) => { cap.order = o; return { status: 'placed', order_id: 'X1' }; },
      getIBKRPositions: async () => [{ symbol: 'SOXS', qty: 0.8 }],
      getIBKROpenOrders: async () => [],
    },
    traderAgent: null,
    tradingMemory: { recordNewOrders: async () => {} },
    tradingStore: { listOrders: () => [] },
    getEffectiveUserId: () => 'u1',
  };
  // stub the quote source the conversion prices against
  const qm = require.resolve('../lib/market-data-yahoo');
  const real = require.cache[qm];
  require.cache[qm] = { id: qm, filename: qm, loaded: true, exports: { getQuotes: async () => [{ ticker: payload.ticker, price }] } };
  try {
    await withClock(now, () => ordersRoutes(
      { method: 'POST', headers: {}, socket: {} }, {},
      new URL('http://127.0.0.1/api/trading/orders/place'), ctx,
    ));
  } finally { if (real) require.cache[qm] = real; else delete require.cache[qm]; }
  return cap;
}

const SELL = { ticker: 'SOXS', side: 'sell', qty: 100, type: 'market' };

test('RTH: a market order stays a market order (no behavior change)', async () => {
  const c = await place(SELL, { now: RTH });
  assert.strictEqual(c.order.type, 'market');
  assert.strictEqual(c.order.outsideRth, undefined);
  assert.strictEqual(c.body.session_note, undefined, 'nothing to caveat during RTH');
});

test('PRE-MARKET: converted to a marketable limit with outsideRth', async () => {
  const c = await place(SELL, { now: PRE, price: 40.20 });
  assert.strictEqual(c.order.type, 'limit');
  assert.strictEqual(c.order.outsideRth, true);
  assert.ok(Math.abs(c.order.limitPrice - 40.12) < 0.01, `sell crosses DOWN 0.2%: ${c.order.limitPrice}`);
  assert.match(c.body.session_note, /would not execute until 09:30/);
});

test('AFTER-HOURS: same conversion', async () => {
  const c = await place(SELL, { now: AFT, price: 40.20 });
  assert.strictEqual(c.order.type, 'limit');
  assert.strictEqual(c.order.outsideRth, true);
});

test('a BUY crosses UP, not down', async () => {
  const c = await place({ ...SELL, side: 'buy' }, { now: PRE, price: 100 });
  assert.ok(c.order.limitPrice > 100, `buy must be marketable upward: ${c.order.limitPrice}`);
});

test('WEEKEND: no conversion, but the response says the order only QUEUES', async () => {
  const c = await place(SELL, { now: SUN });
  assert.strictEqual(c.order.type, 'market', 'nothing executes on a Sunday — a limit would not help');
  assert.strictEqual(c.body.session, 'closed');
  assert.match(c.body.session_note, /QUEUES/);
});

test('an explicit LIMIT from the caller is never rewritten', async () => {
  const c = await place({ ticker: 'SOXS', side: 'sell', qty: 100, type: 'limit', limitPrice: 39.5 }, { now: PRE });
  assert.strictEqual(c.order.type, 'limit');
  assert.strictEqual(c.order.limitPrice, 39.5, 'the operator\'s own price stands');
});

test('no quote available: stays market and SAYS it will not fill', async () => {
  const c = await place(SELL, { now: PRE, price: 0 });
  assert.strictEqual(c.order.type, 'market');
  assert.match(c.body.session_note, /no quote available/);
});
