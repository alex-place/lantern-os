'use strict';

/**
 * orders-fetch-unknown.test.js — an empty orders fetch means UNKNOWN, not
 * "every position is naked" (2026-08-12 hardening).
 *
 * Every re-protect decision reads ONE broker orders fetch per scan. IBKR's
 * CPAPI intermittently answers /iserver/account/orders with an empty array
 * (cold endpoint, session re-auth, maintenance). An empty list makes hasStop()
 * false for EVERY symbol, so the pass concludes the whole book is unprotected
 * and stacks a duplicate GTC stop on each position — the exact mechanism
 * behind the 2026-07-27 incident (488 resting stop-sells, 95,561 shares
 * against 3,772 held: a 25x oversell that goes SHORT on any gap down).
 *
 * The asymmetry that decides the design: a genuinely naked position stays
 * naked for one extra scan (~60s, and the max-loss backstop still guards it),
 * versus a duplicate stop that can flip the account short. Defer, don't guess.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production guard + predicate in auto-trader.js.
const heldCount = (heldPos) => Object.values(heldPos).filter((p) => (Number(p.qty) || 0) > 0).length;
const ordersUnknown = (heldPos, orders) =>
  heldCount(heldPos) > 0 && (!Array.isArray(orders) || orders.length === 0);
const hasStop = (orders, sym) => (orders || []).some((o) =>
  String(o.symbol || '').toUpperCase() === sym &&
  /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
  /submit|pending|presubmit|open|accepted|new|working|held/i.test(o.status || ''));

/** Symbols this scan would place a fresh protective stop on. */
function wouldReprotect(heldPos, orders) {
  if (ordersUnknown(heldPos, orders)) return [];        // production: break before the loop
  return Object.entries(heldPos)
    .filter(([sym, p]) => (Number(p.qty) || 0) > 0 && !hasStop(orders, sym))
    .map(([sym]) => sym);
}

const BOOK = { SPY: { qty: 149 }, DIA: { qty: 190 }, GLD: { qty: 265 } };
const stop = (sym, status = 'PreSubmitted') => ({ symbol: sym, side: 'SELL', orderType: 'Stop', status });

test('the incident shape: empty orders + a full book places ZERO duplicate stops', () => {
  assert.deepStrictEqual(wouldReprotect(BOOK, []), [],
    'an empty fetch must never be read as "all three positions are naked"');
});

test('a null/undefined fetch (request failed) is also UNKNOWN, not unprotected', () => {
  assert.deepStrictEqual(wouldReprotect(BOOK, null), []);
  assert.deepStrictEqual(wouldReprotect(BOOK, undefined), []);
});

test('the live 2026-08-12 book: stops present -> nothing re-protected', () => {
  const orders = [stop('SPY'), stop('DIA'), stop('GLD')];
  assert.deepStrictEqual(wouldReprotect(BOOK, orders), []);
});

test('a GENUINELY naked position is still re-protected when the fetch is readable', () => {
  // Orders came back (non-empty) but GLD has no stop among them — real gap, act on it.
  const orders = [stop('SPY'), stop('DIA')];
  assert.deepStrictEqual(wouldReprotect(BOOK, orders), ['GLD'],
    'the guard must not suppress real re-protection — only blind guessing');
});

test('an unrelated non-empty order list still counts as READABLE', () => {
  // A working BUY on some other symbol proves the endpoint answered; the book
  // is genuinely unprotected and must be re-protected.
  const orders = [{ symbol: 'QQQ', side: 'BUY', orderType: 'Market', status: 'Filled' }];
  assert.deepStrictEqual(wouldReprotect(BOOK, orders).sort(), ['DIA', 'GLD', 'SPY']);
});

test('a flat book with an empty fetch is unambiguous, not UNKNOWN', () => {
  assert.strictEqual(ordersUnknown({}, []), false, 'no positions -> nothing to protect, nothing to defer');
  assert.deepStrictEqual(wouldReprotect({}, []), []);
});

test('dust-only book: qty 0 rows do not make an empty fetch ambiguous', () => {
  assert.strictEqual(ordersUnknown({ SPY: { qty: 0 }, QQQ: { qty: 0 } }, []), false);
});

test('deferral costs at most one scan — the next readable fetch acts normally', () => {
  assert.deepStrictEqual(wouldReprotect(BOOK, []), [], 'scan N: deferred');
  const recovered = [stop('SPY'), stop('DIA')];
  assert.deepStrictEqual(wouldReprotect(BOOK, recovered), ['GLD'], 'scan N+1: the real gap is closed');
});
