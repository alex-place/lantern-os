'use strict';

/**
 * stop-lifecycle.test.js — the re-protect cap counts FAILURES, not lifecycle
 * (2026-08-10 hardening, from the first live session of the full config).
 *
 * Live incident: the cap counted every stop order for a symbol, including
 * stops the engine itself cancelled during healthy cancel-first exit cycles.
 * Each venue-cancelled sell retry added one Cancelled stop row; at 3 the cap
 * refused further re-protection and IWM/SOXL ran naked-stop stretches while
 * their exits retried (149 're-protect capped' rows in one session).
 *
 * Contract: only the parked/refused vocabulary — Inactive, needs_confirmation,
 * rejected — counts as a failed placement. Cancelled (our own lifecycle) and
 * Filled (did its job) never count. The 972-order Inactive-spam incident this
 * cap was built for still trips it.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production expressions in auto-trader.js re-protect block.
const REPROTECT_MAX_ATTEMPTS = 3;
const attemptsFor = (orders, sym) => (orders || []).filter((o) =>
  String(o.symbol || '').toUpperCase() === sym &&
  /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
  /inactive|reject|needs?[_-]?confirm/i.test(o.status || '')).length;
const hasStop = (orders, sym) => (orders || []).some((o) =>
  String(o.symbol || '').toUpperCase() === sym &&
  /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
  /submit|pending|presubmit|open|accepted|new|working|held/i.test(o.status || ''));
const reprotectAllowed = (orders, sym) =>
  !hasStop(orders, sym) && attemptsFor(orders, sym) < REPROTECT_MAX_ATTEMPTS;

const stop = (sym, status) => ({ symbol: sym, side: 'SELL', orderType: 'Stop', status });

test('the exact 2026-08-10 shape: 3 cancelled-by-us stops must NOT starve re-protection', () => {
  const orders = [stop('IWM', 'Cancelled'), stop('IWM', 'Cancelled'), stop('IWM', 'Cancelled')];
  assert.strictEqual(attemptsFor(orders, 'IWM'), 0, 'our own cancels are lifecycle, not failures');
  assert.strictEqual(reprotectAllowed(orders, 'IWM'), true, 'the naked long must get a fresh stop');
});

test('a FILLED stop (it did its job) never counts as a failed attempt', () => {
  const orders = [stop('XLK', 'Filled'), stop('XLK', 'Cancelled')];
  assert.strictEqual(attemptsFor(orders, 'XLK'), 0);
});

test('the 972-order incident shape still trips the cap: 3 Inactive placements = capped', () => {
  const orders = [stop('SPY', 'Inactive'), stop('SPY', 'Inactive'), stop('SPY', 'Inactive')];
  assert.strictEqual(attemptsFor(orders, 'SPY'), 3);
  assert.strictEqual(reprotectAllowed(orders, 'SPY'), false, 'placements that never protect must stop retrying');
});

test('needs_confirmation and Rejected count as failures too', () => {
  const orders = [stop('SQQQ', 'needs_confirmation'), stop('SQQQ', 'Rejected'), stop('SQQQ', 'Inactive')];
  assert.strictEqual(attemptsFor(orders, 'SQQQ'), 3);
  assert.strictEqual(reprotectAllowed(orders, 'SQQQ'), false);
});

test('a WORKING stop means no re-protect regardless of history (never double-protect)', () => {
  const orders = [stop('SMH', 'Cancelled'), stop('SMH', 'PreSubmitted')];
  assert.strictEqual(hasStop(orders, 'SMH'), true);
  assert.strictEqual(reprotectAllowed(orders, 'SMH'), false);
});

test('mixed history: 2 failures + any number of lifecycle rows stays under the cap', () => {
  const orders = [
    stop('TLT', 'Inactive'), stop('TLT', 'needs_confirmation'),
    stop('TLT', 'Cancelled'), stop('TLT', 'Cancelled'), stop('TLT', 'Filled'),
  ];
  assert.strictEqual(attemptsFor(orders, 'TLT'), 2);
  assert.strictEqual(reprotectAllowed(orders, 'TLT'), true, 'one more genuine attempt is still permitted');
});

test('other symbols’ orders never bleed into the count', () => {
  const orders = [stop('IWM', 'Inactive'), stop('QQQ', 'Inactive'), stop('QQQ', 'Inactive')];
  assert.strictEqual(attemptsFor(orders, 'IWM'), 1);
});
