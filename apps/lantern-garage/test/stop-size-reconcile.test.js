'use strict';

/**
 * stop-size-reconcile.test.js — a protective stop must match the position SIZE.
 *
 * Live 2026-08-13: GLD held 66 shares behind a 147-share resting stop, left over
 * from before a partial exit. hasStop() answered "yes, protected" because it
 * only asks whether a stop EXISTS. Had that stop triggered it would have sold 81
 * shares we did not own — an oversell that opens an unintended SHORT, or (per
 * IBKR's oversell protection, observed on the QQQ exit race the same morning) an
 * outright rejection leaving the position naked.
 *
 * Contract: a stop whose size does not match the (whole-share) position is not
 * protection — cancel it so a correctly-sized one replaces it. Both directions
 * matter: oversized oversells, undersized leaves part of the position exposed.
 */

const test = require('node:test');
const assert = require('node:assert');

const stop = (symbol, qty, status = 'PreSubmitted') => ({ symbol, qty, side: 'SELL', orderType: 'Stop', status });

// Mirrors the production expressions.
const stopQtyFor = (orders, sym) => (orders || [])
  .filter((o) => String(o.symbol || '').toUpperCase() === sym
    && /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '')
    && /submit|pending|presubmit|open|accepted|new|working|held/i.test(o.status || ''))
  .reduce((a, o) => a + (Number(o.qty) || 0), 0);

const needsResize = (orders, sym, held) => {
  const h = Math.abs(Number(held) || 0);
  if (h < 1) return false;                      // dust cannot carry a stop
  const q = stopQtyFor(orders, sym);
  return q > 0 && q !== Math.floor(h);
};

test('the exact GLD case: 66 held behind a 147-share stop must be resized', () => {
  const orders = [stop('GLD', 147)];
  assert.strictEqual(stopQtyFor(orders, 'GLD'), 147);
  assert.strictEqual(needsResize(orders, 'GLD', 66), true, 'an oversized stop would sell 81 shares we do not own');
});

test('a correctly-sized stop is left alone (no churn)', () => {
  assert.strictEqual(needsResize([stop('SQQQ', 1614)], 'SQQQ', 1614), false);
});

test('UNDERsized stops are caught too — part of the position would be naked', () => {
  assert.strictEqual(needsResize([stop('SPXS', 1000)], 'SPXS', 2467), true);
});

test('whole-share flooring: 300.8 held wants a 300-share stop, not 301', () => {
  assert.strictEqual(needsResize([stop('SOXS', 300)], 'SOXS', 300.8), false, '300 is correct for 300.8 held');
  assert.strictEqual(needsResize([stop('SOXS', 301)], 'SOXS', 300.8), true, '301 would oversell the fraction');
});

test('sub-share dust is skipped — IBKR cannot place a fractional stop at all', () => {
  assert.strictEqual(needsResize([stop('SOXS', 1)], 'SOXS', 0.8), false);
});

test('no stop at all is NOT a resize case — that is the re-protect pass’s job', () => {
  assert.strictEqual(needsResize([], 'GLD', 66), false, 'zero working stops must not trigger a cancel');
});

test('cancelled and inactive stops do not count toward the resting size', () => {
  const orders = [stop('GLD', 147, 'Cancelled'), stop('GLD', 289, 'Inactive'), stop('GLD', 66)];
  assert.strictEqual(stopQtyFor(orders, 'GLD'), 66, 'only working stops are protection');
  assert.strictEqual(needsResize(orders, 'GLD', 66), false);
});

test('split stops summing to the position are fine; summing wrong are not', () => {
  assert.strictEqual(needsResize([stop('X', 40), stop('X', 26)], 'X', 66), false, '40+26 = 66');
  assert.strictEqual(needsResize([stop('X', 40), stop('X', 40)], 'X', 66), true, '80 would oversell');
});

test('other symbols never bleed into the count', () => {
  const orders = [stop('GLD', 147), stop('SQQQ', 1614)];
  assert.strictEqual(stopQtyFor(orders, 'GLD'), 147);
});
