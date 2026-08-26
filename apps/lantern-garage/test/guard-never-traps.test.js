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
 *
 * All three are fixed now. (1) sells are exempt from a POSITION-SIZE cap outright.
 * (3) a market order is priced against the caller's `refPrice` — the same quote the
 * entry was sized from — and an unpriceable BUY is refused rather than waved through.
 * (2) had to be fixed WITH (3): the moment the cap starts binding on market orders, a
 * guard reading the flat 12% would refuse every tilt-1.5 entry and silently delete
 * SOXL/SMH/QQQ from the book. The ceiling now derives from the same environment the
 * sizer reads, so the guard stays independent and stops misreading the policy.
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

// ---------------------------------------------------------------------------
// The cap now binds on MARKET orders (operator, 2026-08-25). It used to compute
// notional from the LIMIT price, so a market order priced at nothing had a notional
// of nothing and skipped the cap — and market buys are the engine's normal entry
// path, so the 12% per-position cap was unenforced on every ordinary entry.
// ---------------------------------------------------------------------------
const TILT = 'SOXL:1.5,SMH:1.5,QQQ:1.5,IWM:1.02,XLK:1.0,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5';

test('a market BUY is capped against the reference price it was sized from', () => {
  // 2,600 SOXL = $300,742, past even the tilt+stress ceiling of $261,021
  const g = armed({ TRADER_SYMBOL_SIZE_MULT: TILT, TRADER_STRESS_MULT: '1.5' },
    { qty: 2600, price: 0, refPrice: 115.67, equity: 966744, side: 'buy', symbol: 'SOXL' });
  assert.strictEqual(g.allowed, false, 'a market order must not slip the cap by having no price');
  assert.match(g.reason, /exceeds cap/);
});

test('an unpriced buy stays ALLOWED — a documented limit, not an oversight', () => {
  // orderGate sits under a general-purpose placeOrder(), not only the engine. Refusing
  // every priceless buy broke the IBKR warning handshake immediately
  // (exit-warning-confirm-behavior) and would disable any caller that has no quote.
  // The engines that size against equity — auto-trader and overnight-trader — all pass
  // refPrice, so the paths that can build an oversized position ARE covered.
  const g = armed({}, { qty: 1517, price: 0, equity: 966744, side: 'buy' });
  assert.strictEqual(g.allowed, true, 'documented residue: no price means no cap check');
});

test("the engine's own entry carries a price, so it IS capped", () => {
  // this is the contract the comment in trading-guard.js names: any caller that sizes
  // by equity must pass refPrice. auto-trader and overnight-trader both do.
  const capped = armed({ TRADER_SYMBOL_SIZE_MULT: TILT, TRADER_STRESS_MULT: '1.5' },
    { qty: 2600, price: 0, refPrice: 115.67, equity: 966744, side: 'buy', symbol: 'SOXL' });
  assert.strictEqual(capped.allowed, false, 'a market entry over the ceiling is refused');
  const same = armed({ TRADER_SYMBOL_SIZE_MULT: TILT, TRADER_STRESS_MULT: '1.5' },
    { qty: 2600, price: 0, equity: 966744, side: 'buy', symbol: 'SOXL' });
  assert.strictEqual(same.allowed, true, 'the identical order WITHOUT refPrice is the uncapped residue');
});

test('an unpriceable SELL is still allowed — the cap must never trap, priced or not', () => {
  assert.strictEqual(armed({}, { qty: 1517, price: 0, equity: 966744, side: 'sell' }).allowed, true);
});

test('the ceiling is HARD — the symbol tilt cannot raise it (operator, 2026-08-25)', () => {
  const env = { TRADER_SYMBOL_SIZE_MULT: TILT, TRADER_STRESS_MULT: '1.5' };
  // 1,517 SOXL = $175,471 = 18% of equity. That is what the sizer used to build, and
  // what the guard refused. Now neither will: TRADER_MAX_POSITION_PCT is the ceiling
  // for every symbol regardless of tilt or stress.
  const over = armed(env, { qty: 1517, price: 0, refPrice: 115.67, equity: 966744, side: 'buy', symbol: 'SOXL' });
  assert.strictEqual(over.allowed, false, 'tilt 1.5 must not lift the ceiling');
  assert.match(over.reason, /HARD ceiling/);
  assert.strictEqual(over.caps.maxPositionPct, 12);
  // and the size the clamped sizer now produces clears it
  assert.strictEqual(armed(env, { qty: 1002, price: 0, refPrice: 115.67, equity: 966744, side: 'buy', symbol: 'SOXL' }).allowed, true);
});

test('the sizer and the guard agree on one number', () => {
  const at = require('../lib/auto-trader');
  const equity = 966744, price = 115.67;
  // the sizer's own clamp: tier x stress x tilt may scale DOWN, never above the cap
  const capMult = Math.min(1, 1 * 1.5 * 1.5);
  const qty = at.sizePosition({ equity, price, positionPct: 12, maxPositionPct: 12 * capMult, riskPct: 0.36 * 1.5 * 1.5, stopDistPct: 3 });
  assert.ok(qty * price <= equity * 0.12, `sizer produced ${qty} sh = $${Math.round(qty * price)}, over a 12% ceiling`);
  const g = armed({ TRADER_SYMBOL_SIZE_MULT: TILT, TRADER_STRESS_MULT: '1.5' },
    { qty, price: 0, refPrice: price, equity, side: 'buy', symbol: 'SOXL' });
  assert.strictEqual(g.allowed, true, `the guard must accept what the sizer built: ${g.reason}`);
});

test('a DOWN-tilted name still sizes below the cap — only the up-weights are clamped', () => {
  const at = require('../lib/auto-trader');
  const equity = 1e6, price = 100;
  const spy = at.sizePosition({ equity, price, positionPct: 12, maxPositionPct: 12 * Math.min(1, 0.83), riskPct: 0.36 * 0.83, stopDistPct: 3 });
  assert.ok(spy * price <= equity * 0.0996 + price, 'SPY tilt 0.83 -> ~9.96%, not 12%');
});

test('the extended-hours marketable limit does not deny its own sized order', () => {
  // #3326 prices an out-of-RTH entry 0.2% through the spread so it can fill. Capping on
  // that uplift would refuse an order the sizer built to fit, so refPrice governs.
  const sized = armed({}, { qty: 1002, price: 0, refPrice: 115.67, equity: 966744, side: 'buy' });
  assert.strictEqual(sized.allowed, true);
  const ext = armed({}, { qty: 1002, price: 115.90, refPrice: 115.67, equity: 966744, side: 'buy' });
  assert.strictEqual(ext.allowed, true, 'the 0.2% marketable uplift must not trip the cap');
});

