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

test('WEEKEND: the session is reported as closed', async () => {
  // NOTE: this test originally asserted the order stayed a plain market order
  // and that the note said it "QUEUES". Both were wrong — see #3327: TIF=DAY
  // expires on a session-less day, so nothing queued. The conversion behavior
  // is now pinned by the GTC tests at the bottom of this file.
  const c = await place(SELL, { now: SUN, price: 40.20 });
  assert.strictEqual(c.body.session, 'closed');
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

// ── closed-market orders must actually SURVIVE to the next session (#3327) ──
// The prior code said "queues" and shipped TIF=DAY, which expires at the end of
// a day that had no session. Live proof: the 0.8-share SOXS dust order was
// accepted Saturday, reported as queued, and by Monday 11:38 the position was
// untouched with no order anywhere. Nothing rested; the claim was false.

test('WEEKEND: order becomes a marketable GTC limit that survives to the open', async () => {
  const c = await place(SELL, { now: SUN, price: 40.20 });
  assert.strictEqual(c.order.timeInForce, 'gtc', 'DAY would expire before Monday');
  assert.strictEqual(c.order.type, 'limit', 'a resting order needs a price');
  assert.ok(c.order.limitPrice < 40.20, `sell limit must be marketable: ${c.order.limitPrice}`);
  assert.match(c.body.session_note, /GTC limit/);
  assert.match(c.body.session_note, /DAY order would expire/);
});

test('WEEKEND buy rests above the market, not below', async () => {
  const c = await place({ ...SELL, side: 'buy' }, { now: SUN, price: 100 });
  assert.strictEqual(c.order.timeInForce, 'gtc');
  assert.ok(c.order.limitPrice > 100, `buy limit must be marketable upward: ${c.order.limitPrice}`);
});

test('WEEKEND with no quote: stays market and WARNS it may expire — never claims it queues', async () => {
  const c = await place(SELL, { now: SUN, price: 0 });
  assert.strictEqual(c.order.type, 'market');
  assert.match(c.body.session_note, /may expire unfilled/);
  assert.doesNotMatch(c.body.session_note, /QUEUES/);
});

test('RTH and extended paths are unchanged by the GTC rule', async () => {
  const rth = await place(SELL, { now: RTH, price: 40.20 });
  assert.strictEqual(rth.order.timeInForce, undefined, 'RTH keeps the bridge default');
  const ext = await place(SELL, { now: PRE, price: 40.20 });
  assert.strictEqual(ext.order.timeInForce, undefined, 'extended relies on outsideRth, not GTC');
  assert.strictEqual(ext.order.outsideRth, true);
});
