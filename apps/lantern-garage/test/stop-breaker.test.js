'use strict';

/**
 * stop-breaker.test.js — the daily circuit breaker (tail gate #2, 2026-08-08).
 *
 * The 2008-class worst days were CROSS-symbol churn: stops freed slots, fresh
 * symbols refilled them into the same crashing market. Replay on the live
 * config (both windows, on top of the per-symbol cooldown): K=2 turned the
 * worst day from -3.97% into -1.40% — the pure cap x floor structural bound —
 * while IMPROVING %/trade in both windows (crash-day refills were -EV).
 *
 * Pure-logic mirror of the production counter/predicate in auto-trader.js.
 */

const test = require('node:test');
const assert = require('node:assert');

function mkBreaker() {
  let day = null, count = 0;
  return {
    note(d) { if (day !== d) { day = d; count = 0; } count++; },
    tripped(d, k) { return k > 0 && day === d && count >= k; },
    state() { return { day, count }; },
    load(s) { day = s.day; count = s.count; },
  };
}

test('two stop fills in one session trip the breaker; one does not', () => {
  const b = mkBreaker();
  b.note('2026-08-10');
  assert.strictEqual(b.tripped('2026-08-10', 2), false, 'one stop is a normal day');
  b.note('2026-08-10');
  assert.strictEqual(b.tripped('2026-08-10', 2), true, 'second stop = hostile tape, no more entries');
});

test('the breaker resets on the next session', () => {
  const b = mkBreaker();
  b.note('2026-08-10'); b.note('2026-08-10');
  assert.strictEqual(b.tripped('2026-08-10', 2), true);
  assert.strictEqual(b.tripped('2026-08-11', 2), false, 'a new day starts clean');
  b.note('2026-08-11');
  assert.strictEqual(b.state().count, 1, 'the counter restarted, not accumulated');
});

test('K=0 disables the breaker entirely', () => {
  const b = mkBreaker();
  for (let i = 0; i < 10; i++) b.note('2026-08-10');
  assert.strictEqual(b.tripped('2026-08-10', 0), false);
});

test('the breaker survives a restart via persisted state', () => {
  const b = mkBreaker();
  b.note('2026-08-10'); b.note('2026-08-10');
  const b2 = mkBreaker();
  b2.load(b.state());
  assert.strictEqual(b2.tripped('2026-08-10', 2), true,
    'a mid-crash restart must not re-open the entry gate');
});

test('the exact 2008-10-06 shape: after 2 stops, the other 10 refills never happen', () => {
  const b = mkBreaker();
  let entriesAllowed = 0;
  for (let i = 0; i < 12; i++) {
    if (!b.tripped('2008-10-06', 2)) entriesAllowed++;
    b.note('2008-10-06');
  }
  assert.strictEqual(entriesAllowed, 2, 'the day is capped at its first wave');
});
