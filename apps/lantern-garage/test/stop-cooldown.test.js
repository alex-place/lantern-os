'use strict';

/**
 * stop-cooldown.test.js — post-stop re-entry cooldown (tail gate 2026-08-08).
 *
 * Every worst backtest day was churn: stop out, re-buy the still-falling
 * washout, stop again. Lab (19 symbols, live config, both windows): barring
 * re-entry for the stop session + 1 trading day HALVES the holdout's worst day
 * (-2.86% -> -1.40%) at a cost of -0.004%/trade. These tests pin the pure
 * date logic the production gate uses.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirror of the production helpers (auto-trader.js).
function nextTradingDates(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
const blocked = (todayEt, through) => !!through && todayEt <= through;

test('a Wednesday stop bars Wednesday AND Thursday; Friday trades again', () => {
  const through = nextTradingDates('2026-08-12', 1);   // Wed + 1 trading day
  assert.strictEqual(through, '2026-08-13');
  assert.strictEqual(blocked('2026-08-12', through), true, 'rest of the stop session');
  assert.strictEqual(blocked('2026-08-13', through), true, 'the next session');
  assert.strictEqual(blocked('2026-08-14', through), false, 'free again');
});

test('a Friday stop skips the weekend and bars Monday', () => {
  const through = nextTradingDates('2026-08-14', 1);   // Fri + 1 trading day = Mon
  assert.strictEqual(through, '2026-08-17');
  assert.strictEqual(blocked('2026-08-15', through), true, 'Saturday (market closed anyway)');
  assert.strictEqual(blocked('2026-08-17', through), true, 'Monday is the barred session');
  assert.strictEqual(blocked('2026-08-18', through), false, 'Tuesday trades');
});

test('cooldown 0 disables the gate (no through-date is ever set)', () => {
  assert.strictEqual(blocked('2026-08-12', undefined), false);
});

test('two trading days spans a weekend correctly', () => {
  assert.strictEqual(nextTradingDates('2026-08-13', 2), '2026-08-17', 'Thu + 2 = Mon');
});

test('only STOP exits arm the cooldown — ladder/signal exits never do', () => {
  // Mirrors the production predicate on reconciled fill rows.
  const arms = (row) => String(row.order_type || '') === 'Stop' || /(^|\b)stop\b/i.test(String(row.reason || ''));
  assert.strictEqual(arms({ order_type: 'Stop', reason: 'broker fill' }), true);
  assert.strictEqual(arms({ order_type: 'Market', reason: 'stop' }), true);
  assert.strictEqual(arms({ order_type: 'Market', reason: 'zone_r2 (runner target 718.985)' }), false);
  assert.strictEqual(arms({ order_type: 'Market', reason: 'signal_exit' }), false);
  assert.strictEqual(arms({ order_type: 'Market', reason: 'r2_trail (peak 723.60, floor 716.36)' }), false,
    'a winning trail exit must not bar the symbol');
});
