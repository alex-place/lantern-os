'use strict';

/**
 * fill-ledger.test.js — exits must be recorded from BROKER FILLS.
 *
 * The ledger was written at order-placement time from the position's last mark.
 * Across 2026-08-05..07 that was wrong in both directions every session, and the
 * ledger is what the report, the scorecard and any calibration read. Each test
 * below is a real incident from those sessions.
 */

const test = require('node:test');
const assert = require('node:assert');
const { newExitRows, idsToRemember, isFilledSell } = require('../lib/fill-ledger');

const entryFor = (map) => (sym) => map[sym] || {};

test('XLK 2026-08-07: the row is priced at the FILL, not the mark', () => {
  // Ledger logged -$319.62 from mark 187.56. The stop actually filled at 186.65
  // => -$641.62. Every stop that week was understated 30-60%.
  const orders = [{ orderId: '1', symbol: 'XLK', side: 'SELL', orderType: 'Stop', filledQty: 356, avgPrice: 186.65, status: 'Filled' }];
  const rows = newExitRows(orders, new Set(), entryFor({ XLK: { avg_entry_price: 188.453146, reason: 'stop' } }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].exit, 186.65);
  assert.ok(Math.abs(rows[0].pnl - (-641.62)) < 0.5, `expected ~-641.62, got ${rows[0].pnl}`);
  assert.strictEqual(rows[0].source, 'fill');
});

test('QQQ 2026-08-07: a CANCELLED exit order never becomes a ledger row', () => {
  // Two zone_r2 rows were logged (+$183.00 and +$270.54) for ONE position; the
  // second sell was cancelled unfilled. Only the fill may count.
  const orders = [
    { orderId: 'A', symbol: 'QQQ', side: 'SELL', orderType: 'Market', filledQty: 46, avgPrice: 720.851304, status: 'Filled' },
    { orderId: 'B', symbol: 'QQQ', side: 'SELL', orderType: 'Market', filledQty: 0, avgPrice: null, status: 'Cancelled' },
  ];
  const rows = newExitRows(orders, new Set(), entryFor({ QQQ: { avg_entry_price: 716.1017413, reason: 'zone_r2' } }));
  assert.strictEqual(rows.length, 1, 'exactly one exit for one position');
  assert.ok(Math.abs(rows[0].pnl - 218.48) < 0.5, `expected ~+218.48, got ${rows[0].pnl}`);
});

test('an order is never logged twice across scans', () => {
  const orders = [{ orderId: '1', symbol: 'SPY', side: 'SELL', filledQty: 43, avgPrice: 770.03, status: 'Filled' }];
  const logged = new Set();
  const first = newExitRows(orders, logged, entryFor({ SPY: { avg_entry_price: 771.51 } }));
  assert.strictEqual(first.length, 1);
  for (const id of idsToRemember(orders)) logged.add(id);
  const second = newExitRows(orders, logged, entryFor({ SPY: { avg_entry_price: 771.51 } }));
  assert.strictEqual(second.length, 0, 'the same fill must not be re-logged next scan');
});

test('a cancelled order is remembered so it can never later be mistaken for a fill', () => {
  const orders = [{ orderId: 'B', symbol: 'QQQ', side: 'SELL', filledQty: 0, status: 'Cancelled' }];
  assert.deepStrictEqual(idsToRemember(orders), ['B']);
});

test('BUY fills are not exits', () => {
  const orders = [{ orderId: '1', symbol: 'SPY', side: 'BUY', filledQty: 43, avgPrice: 771.51, status: 'Filled' }];
  assert.strictEqual(newExitRows(orders, new Set(), entryFor({})).length, 0);
  assert.deepStrictEqual(idsToRemember(orders), [], 'buys are not tracked as exit ids');
});

test('an unknown entry price yields null P&L, never a guessed number', () => {
  // SOXL 2026-08-06 vanished from the ledger entirely. A row with an honest null
  // beats both a dropped trade and an invented figure.
  const orders = [{ orderId: '9', symbol: 'SOXL', side: 'SELL', filledQty: 481, avgPrice: 138.12, status: 'Filled' }];
  const rows = newExitRows(orders, new Set(), entryFor({}));
  assert.strictEqual(rows.length, 1, 'the trade must still be recorded');
  assert.strictEqual(rows[0].pnl, null);
  assert.strictEqual(rows[0].exit, 138.12);
});

test('a fill with no price is skipped rather than priced at zero', () => {
  const orders = [{ orderId: '1', symbol: 'SPY', side: 'SELL', filledQty: 10, avgPrice: 0, status: 'Filled' }];
  assert.strictEqual(newExitRows(orders, new Set(), entryFor({ SPY: { avg_entry_price: 100 } })).length, 0);
});

test('the exit reason from our own intent labels the fill row', () => {
  const orders = [{ orderId: '1', symbol: 'GLD', side: 'SELL', filledQty: 85, avgPrice: 389.30, status: 'Filled' }];
  const rows = newExitRows(orders, new Set(), entryFor({ GLD: { avg_entry_price: 391.3217677, reason: 'zone_r1' } }));
  assert.strictEqual(rows[0].reason, 'zone_r1');
  const anon = newExitRows(orders, new Set(), entryFor({ GLD: { avg_entry_price: 391.3217677 } }));
  assert.strictEqual(anon[0].reason, 'broker fill', 'a broker-side stop with no intent still gets a row');
});

test('isFilledSell only accepts genuinely filled sells', () => {
  assert.strictEqual(isFilledSell({ side: 'SELL', filledQty: 5 }), true);
  assert.strictEqual(isFilledSell({ side: 'SELL', filledQty: 0 }), false);
  assert.strictEqual(isFilledSell({ side: 'BUY', filledQty: 5 }), false);
  assert.strictEqual(isFilledSell(null), false);
});

test('partial fills are recorded at the quantity actually filled', () => {
  const orders = [{ orderId: '1', symbol: 'IWM', side: 'SELL', qty: 191, filledQty: 100, avgPrice: 299.00, status: 'Submitted' }];
  const rows = newExitRows(orders, new Set(), entryFor({ IWM: { avg_entry_price: 300.64 } }));
  assert.strictEqual(rows[0].qty, 100, 'P&L must reflect what filled, not what was ordered');
  assert.ok(Math.abs(rows[0].pnl - (-164)) < 1);
});
