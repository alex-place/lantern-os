'use strict';
/**
 * guard-never-traps.test.js — a cap on POSITION SIZE must never stop a position
 * from being CLOSED (operator, 2026-08-25).
 *
 * Reported live while flattening both books for an A/B: the app refused to sell
 * SOXL. 1,517 shares at $115.67 = $175,471 against a cap of 12% x $966,744 =
 * $116,009. The position could be opened and then not shut.
 *
 * Three things had to line up, and all three were already true:
 *   1. `side` was in orderGate's JSDoc from the start and ibkr-cpapi.js has always
 *      passed it — it was never destructured, so sells were judged like buys.
 *   2. The sizer's cap SCALES (room tier x stress x symbol tilt); auto-trader sizes
 *      SOXL at 12% x 1.5 = 18%, and 27% at VIX >= 20. This guard reads the raw 12%,
 *      so the engine can legitimately build a position the guard will not transact.
 *   3. The cap only fires when a price is present, so a MARKET order skips it. The
 *      entry was a market buy — inert. #3326 then converts an out-of-RTH flatten to
 *      a marketable LIMIT so it can execute, which is what gives it the price that
 *      trips the cap.
 *
 * Net: the cap was inert for the order that took the risk and binding on the order
 * that would have shed it.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const guard = require('../lib/trading-guard');

// the live numbers from the report
const SOXL = { qty: 1517, price: 115.67, equity: 966744 };
const withEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k] of Object.entries(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
};
const armed = (extra, o) => withEnv({ TRADER_LIVE: '1', TRADER_MAX_POSITION_PCT: '12', ...extra },
  () => guard.orderGate({ mode: 'paper', ...o }));

test('the exact order the operator could not place is allowed', () => {
  const g = armed({}, { ...SOXL, side: 'sell' });
  assert.strictEqual(g.allowed, true, `a sell must never be capped by a position-size limit: ${g.reason}`);
});

test('the same notional as a BUY is still refused — the cap still caps', () => {
  const g = armed({}, { ...SOXL, side: 'buy' });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /exceeds cap/, 'buys keep the per-position notional cap');
});

test('an unlabelled order is treated as a buy — the cap is the safe default', () => {
  const g = armed({}, { qty: SOXL.qty, price: SOXL.price, equity: SOXL.equity });
  assert.strictEqual(g.allowed, false, 'no side supplied must not silently unlock the cap');
});

test('SELL/Sell/sell all count — brokers do not agree on case', () => {
  for (const side of ['sell', 'SELL', 'Sell']) {
    assert.strictEqual(armed({}, { ...SOXL, side }).allowed, true, `side=${side}`);
  }
});

test('every OTHER gate still applies to a sell', () => {
  // the qty sanity ceiling
  const big = armed({ MAX_ORDER_QTY: '100' }, { ...SOXL, side: 'sell' });
  assert.strictEqual(big.allowed, false);
  assert.match(big.reason, /exceeds MAX_ORDER_QTY/);
  // a nonsense quantity
  assert.strictEqual(armed({}, { qty: 0, price: 10, equity: 1e6, side: 'sell' }).allowed, false);
  // the master arm switch
  const dry = withEnv({ TRADER_LIVE: '0', TRADER_MAX_POSITION_PCT: '12' },
    () => guard.orderGate({ mode: 'paper', ...SOXL, side: 'sell' }));
  assert.strictEqual(dry.allowed, false);
  assert.match(dry.reason, /TRADER_LIVE=0/);
  // an unknown account mode
  assert.strictEqual(armed({}, { ...SOXL, side: 'sell', mode: undefined }).allowed, false);
  // a real-money account still needs the second opt-in
  const live = withEnv({ TRADER_LIVE: '1', TRADER_MAX_POSITION_PCT: '12', TRADER_ALLOW_LIVE_ACCOUNT: '0' },
    () => guard.orderGate({ mode: 'live', ...SOXL, side: 'sell' }));
  assert.strictEqual(live.allowed, false);
  assert.match(live.reason, /TRADER_ALLOW_LIVE_ACCOUNT/);
});

test('a global halt still stops a sell — the kill switch outranks everything', () => {
  const fs = require('fs');
  const existed = fs.existsSync(guard.TRADING_PAUSED);
  if (!existed) { fs.mkdirSync(require('path').dirname(guard.TRADING_PAUSED), { recursive: true }); fs.writeFileSync(guard.TRADING_PAUSED, 'test'); }
  try {
    const g = armed({}, { ...SOXL, side: 'sell' });
    assert.strictEqual(g.allowed, false);
    assert.match(g.reason, /global halt/);
  } finally { if (!existed) fs.unlinkSync(guard.TRADING_PAUSED); }
});

test('a sell that fits under the cap was never the problem, and still passes', () => {
  assert.strictEqual(armed({}, { qty: 100, price: 115.67, equity: 966744, side: 'sell' }).allowed, true);
});

test('a market order (no price) is unaffected on both sides — the cap needs a price', () => {
  assert.strictEqual(armed({}, { qty: 1517, price: 0, equity: 966744, side: 'sell' }).allowed, true);
  assert.strictEqual(armed({}, { qty: 1517, price: 0, equity: 966744, side: 'buy' }).allowed, true,
    'documented behaviour, and the reason the oversized entry was placed at all');
});
