'use strict';

/**
 * orders-accept-warnings.test.js — manual orders are the user's decision, and a Flatten
 * closes what the broker actually holds.
 *
 * 2026-10-26. Stable carried an accidental XLE short (-2,628). The operator's Flatten and the
 * order ticket both dead-ended on IBKR's precautionary warning ("BUY 2,628 XLE size exceeds
 * the Size Limit of 500. Are you sure?"): this route cleared warnings on sells only (P0-8,
 * 2026-08-14) and, from #3785, on buys it could verify as short covers. The verification read
 * IBKR's portfolio, which lags fills, so once the short had been covered a Flatten sized from
 * the stale -2,628 bought another 2,628 (long ~$181k), and the next one was refused as
 * "not verified". Operator: "on manual orders there shouldnt be limitations on what the
 * user can do like there are on the autonomous trader".
 *
 * Pinned here:
 *   - every manual order (buy or sell, ticket or Flatten) accepts IBKR's warnings, carries
 *     manual:true (the engine's position-size cap does not judge it), and the reply lists
 *     what IBKR said (accepted_warnings);
 *   - a Flatten re-reads the position FRESH at the broker and closes exactly what is held,
 *     less a closing order already working; already flat, the other side of what the page
 *     showed, or an unreadable book: nothing is sent and the reply says which.
 * P0-8 still governs the engine, whose orders never come through this route.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ordersRoutes = require('../routes/trading/orders');

// Outside the regular session the route prices a resting limit from a live quote, and with
// no quote it REFUSES before touching the bridge (the 2026-08-28 naked-book rule). The quote is
// pinned so these tests do not depend on Yahoo answering whoever runs them, whenever.
require('../lib/market-data-yahoo').getQuotes = async (tickers) =>
  (tickers || []).map((ticker) => ({ ticker, price: 10, chg_pct: 0, session: 'regular' }));

async function drive(payload, { positions, openOrders, reply } = {}) {
  const captured = { orderReq: null, response: null, code: null, posReads: [] };
  const ctx = {
    sendJson: (_res, body, code) => { captured.response = body; captured.code = code; },
    collectRequestBody: async () => JSON.stringify(payload),
    bridge: {
      getIBKRAccount: async () => ({ account_id: 'DUR000000', equity: 963000, mode: 'paper' }),
      placeIBKROrder: async (_uid, orderReq) => { captured.orderReq = orderReq; return reply ? reply(orderReq) : { status: 'error', error: 'stub' }; },
      // absent option -> the book is unreadable (throws), the conservative default
      getIBKRPositions: async (_uid, opts) => { captured.posReads.push(opts || null); if (positions === undefined) throw new Error('feed down'); return positions; },
      getIBKROpenOrders: async () => { if (openOrders === 'throw') throw new Error('orders feed down'); return openOrders === undefined ? [] : openOrders; },
      cancelIBKROrder: async () => ({ status: 'cancelled' }),
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

// ── manual orders accept IBKR's warnings, buys and sells alike ──────────────

test('a manual BUY accepts IBKR warnings and is not judged by the engine size cap', async () => {
  const c = await drive({ ticker: 'XLE', side: 'buy', qty: 2628, type: 'market' });
  assert.ok(c.orderReq, 'the order reaches the broker bridge');
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'the page already had the user confirm this order');
  assert.strictEqual(c.orderReq.manual, true);
});

test('a manual SELL accepts IBKR warnings too, whatever the book says', async () => {
  const c = await drive({ ticker: 'GLD', side: 'sell', qty: 147, type: 'market' }, { positions: [{ symbol: 'GLD', qty: 66 }] });
  assert.strictEqual(c.orderReq.acceptWarnings, true, 'a person may sell more than is held; that is their call');
  assert.strictEqual(c.orderReq.qty, 147, 'a ticket order is sent as asked; only a Flatten is re-sized from the book');
});

test('IBKR\'s accepted warnings come back on the reply, in IBKR\'s words', async () => {
  const c = await drive({ ticker: 'XLE', side: 'buy', qty: 2628, type: 'market' }, {
    reply: () => ({ status: 'placed', order_id: '1', ticker: 'XLE', side: 'buy', qty: 2628,
      warnings: [{ id: 'w1', message: ['The following order "BUY 2,628 XLE ARCA" size exceeds the Size Limit of 500. Are you sure you want to submit this order?'] }] }),
  });
  assert.strictEqual(c.response.status, 'placed');
  assert.deepStrictEqual(c.response.accepted_warnings, ['The following order "BUY 2,628 XLE ARCA" size exceeds the Size Limit of 500. Are you sure you want to submit this order?']);
});

test('the old explicit flag is irrelevant now: absent or present, the order accepts', async () => {
  const a = await drive({ ticker: 'SOXS', side: 'buy', qty: 100, type: 'market', acceptWarnings: false });
  assert.strictEqual(a.orderReq.acceptWarnings, true);
});

// ── FLATTEN MEANS FLAT: sized from the broker's fresh book ──────────────────

test('a Flatten reads the book FRESH and closes exactly what is held, not the page\'s stale qty', async () => {
  const c = await drive(
    { ticker: 'XLE', side: 'buy', qty: 2628, type: 'market', flatten: true },
    { positions: [{ symbol: 'XLE', qty: -1000 }] },     // partly covered elsewhere; the page still showed -2,628
  );
  assert.deepStrictEqual(c.posReads[c.posReads.length - 1], { fresh: true }, 'the position read must bypass the caches');
  assert.strictEqual(c.orderReq.qty, 1000, 'close what is held');
  assert.strictEqual(c.orderReq.side, 'buy');
});

test('THE 10:39 DOUBLE: the page shows a short the broker no longer has -> nothing is bought', async () => {
  const c = await drive(
    { ticker: 'XLE', side: 'buy', qty: 2628, type: 'market', flatten: true },
    { positions: [{ symbol: 'XLE', qty: 2628 }] },      // covered already, then bought again: long at the broker
  );
  assert.strictEqual(c.orderReq, null, 'no order may be sent');
  assert.strictEqual(c.response.status, 'error');
  assert.match(c.response.reason, /XLE is LONG 2628 at the broker, not short as the page showed/);
});

test('already flat at the broker -> nothing is sent, and the reply says so', async () => {
  const c = await drive({ ticker: 'XLE', side: 'buy', qty: 2628, type: 'market', flatten: true }, { positions: [{ symbol: 'GLD', qty: 66 }] });
  assert.strictEqual(c.orderReq, null);
  assert.match(c.response.reason, /already flat at the broker/);
});

test('a closing order already working counts: a second Flatten click sends nothing', async () => {
  const c = await drive(
    { ticker: 'SPXS', side: 'sell', qty: 2467, type: 'market', flatten: true },
    {
      positions: [{ symbol: 'SPXS', qty: 2467 }],
      openOrders: [{ symbol: 'SPXS', side: 'SELL', qty: 2467, orderType: 'Market', status: 'Submitted' }],   // the 2026-08-14 pre-market double
    },
  );
  assert.strictEqual(c.orderReq, null);
  assert.match(c.response.reason, /a closing order for 2467 is already working/);
});

test('a protective STOP is not a closing order: the Flatten still closes the position', async () => {
  const c = await drive(
    { ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market', flatten: true },
    {
      positions: [{ symbol: 'SQQQ', qty: 1614 }],
      openOrders: [{ symbol: 'SQQQ', side: 'SELL', qty: 1614, orderType: 'Stop', status: 'PreSubmitted' }],
    },
  );
  assert.strictEqual(c.orderReq.qty, 1614);
});

test('fractional book: a Flatten of 3057.8 SOXS sends the whole 3057', async () => {
  const c = await drive({ ticker: 'SOXS', side: 'sell', qty: 3057.8, type: 'market', flatten: true }, { positions: [{ symbol: 'SOXS', qty: 3057.8 }] });
  assert.strictEqual(c.orderReq.qty, 3057);
});

test('an unreadable book or working-orders feed -> a Flatten sends nothing (never acts blind)', async () => {
  const a = await drive({ ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market', flatten: true });   // positions throw
  assert.strictEqual(a.orderReq, null);
  assert.match(a.response.reason, /could not be read fresh at the broker/);
  const b = await drive({ ticker: 'SQQQ', side: 'sell', qty: 1614, type: 'market', flatten: true }, { positions: [{ symbol: 'SQQQ', qty: 1614 }], openOrders: 'throw' });
  assert.strictEqual(b.orderReq, null);
  assert.match(b.response.reason, /working orders could not be read/);
});

test('a sub-share remnant is flat for a Flatten (dust has its own Clear-dust path)', async () => {
  const c = await drive({ ticker: 'SOXS', side: 'sell', qty: 0.8, type: 'market', flatten: true }, { positions: [{ symbol: 'SOXS', qty: 0.8 }] });
  assert.strictEqual(c.orderReq, null);
  assert.match(c.response.reason, /already flat/);
});

// ── FLATTEN IS IDEMPOTENT (2026-10-26): four presses sent four XLE orders ──
// Each test uses its own symbol: the route remembers the last Flatten per account and symbol.

const placedReply = (o) => ({ status: 'placed', order_id: 'F1', ticker: o.ticker, side: o.side, qty: o.qty });

test('pressing Flatten again while the broker still shows the old position sends NOTHING', async () => {
  const book = { positions: [{ symbol: 'XLB', qty: 2628 }], reply: placedReply };
  const first = await drive({ ticker: 'XLB', side: 'sell', qty: 2628, type: 'market', flatten: true }, book);
  assert.strictEqual(first.orderReq.qty, 2628);
  const again = await drive({ ticker: 'XLB', side: 'sell', qty: 2628, type: 'market', flatten: true }, book);   // IBKR has not reported the fill yet
  assert.strictEqual(again.orderReq, null, 'the second press would have opened a short');
  assert.match(again.response.reason, /a Flatten \(SELL 2628\) was sent \d+ s ago and the broker still shows LONG 2628, so nothing was placed again/);
});

test('two presses landing together place ONE order', async () => {
  let placed = 0;
  const book = { positions: [{ symbol: 'XLU', qty: -500 }], reply: (o) => { placed += 1; return placedReply(o); } };
  const [a, b] = await Promise.all([
    drive({ ticker: 'XLU', side: 'buy', qty: 500, type: 'market', flatten: true }, book),
    drive({ ticker: 'XLU', side: 'buy', qty: 500, type: 'market', flatten: true }, book),
  ]);
  assert.strictEqual(placed, 1, 'exactly one order reached the broker');
  assert.strictEqual([a, b].filter((c) => c.orderReq).length, 1);
});

test('once the broker shows the fill, the next press finds the position flat', async () => {
  await drive({ ticker: 'XLP', side: 'sell', qty: 300, type: 'market', flatten: true }, { positions: [{ symbol: 'XLP', qty: 300 }], reply: placedReply });
  const after = await drive({ ticker: 'XLP', side: 'sell', qty: 300, type: 'market', flatten: true }, { positions: [], reply: placedReply });
  assert.strictEqual(after.orderReq, null);
  assert.match(after.response.reason, /already flat at the broker/);
});

test('a Flatten the broker refused can be retried at once', async () => {
  const refused = await drive({ ticker: 'XLV', side: 'sell', qty: 100, type: 'market', flatten: true },
    { positions: [{ symbol: 'XLV', qty: 100 }], reply: () => ({ status: 'error', error: 'rejected by broker' }) });
  assert.ok(refused.orderReq, 'the first attempt was sent');
  const retry = await drive({ ticker: 'XLV', side: 'sell', qty: 100, type: 'market', flatten: true },
    { positions: [{ symbol: 'XLV', qty: 100 }], reply: placedReply });
  assert.strictEqual(retry.orderReq.qty, 100, 'a refused send is forgotten, so the retry goes out');
});

test('ticket orders are not deduplicated: an explicit repeat order is the user call', async () => {
  const book = { positions: [{ symbol: 'XLI', qty: 100 }], reply: placedReply };
  const a = await drive({ ticker: 'XLI', side: 'buy', qty: 100, type: 'market' }, book);
  const b = await drive({ ticker: 'XLI', side: 'buy', qty: 100, type: 'market' }, book);
  assert.ok(a.orderReq && b.orderReq);
});
