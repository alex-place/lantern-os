'use strict';

/**
 * entry-exit-brakes.test.js — regression pins for the 2026-08-08 audit fixes.
 *
 * Four money-path bugs, each driven through the REAL auto-trader module (the
 * audit found these escaped precisely because older tests re-implemented the
 * production expressions locally):
 *   1. The PLACED broker stop must be the same stop that sized the position and
 *      passed the RR gate (_stopDistEff), not the pre-derivation structural one.
 *   2. The daily-loss circuit breaker must arm on {dailyPnl} object shapes
 *      (Alpaca/house/demo facades), not only on IBKR's bare number.
 *   3. The gross cash-reserve brake must count entries placed earlier in the
 *      SAME scan (the concurrency cap's 2026-08-07 blind spot, gross edition).
 *   4. An in-flight exit whose order died at the broker must un-freeze after
 *      two order-less scans + the re-fire debounce, instead of stranding the
 *      position from every engine exit until it leaves the book.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const p = require('path');

{
  const _tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'brakes-'));
  process.env.TRADER_TRADES_LOG = p.join(_tmp, 'trades.jsonl');
  process.env.TRADER_STATE_FILE = p.join(_tmp, 'state.json');
}
const at = require('../lib/auto-trader');

function mkBridge({ positions = [], buys, sells, openOrders = [], dayPnl = 0, sellStatus = 'placed' }) {
  return {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions,
    getIBKROpenOrders: async () => openOrders,
    getIBKRDayPnl: async () => dayPnl,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => {
      if (/buy/i.test(o.side)) { buys.push(o); return { status: 'placed' }; }
      sells.push(o);
      return { status: /stop/i.test(o.type || '') ? 'placed' : sellStatus };
    },
  };
}

const BASE_ENV = {
  TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0', TRADER_MOMENTUM_EXIT: '0',
  TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_LOG_SKIPS: '0', TRADER_MAX_CONCURRENT: '0',
};

async function run({ bridgeOpts, signals, env, now }) {
  const saved = { ...process.env };
  const buys = bridgeOpts.buys || [], sells = bridgeOpts.sells || [];
  try {
    Object.assign(process.env, BASE_ENV, env || {});
    const out = await at.runAutoTrade({ signals }, {
      bridge: mkBridge({ ...bridgeOpts, buys, sells }),
      userId: 'u', now: now || 1_700_000_000_000,
    });
    return { out, buys, sells };
  } finally { process.env = saved; }
}

const bull = (sym, zones) => ({
  symbol: sym, direction: 'BULLISH', entry_price: 100, atr: 1, zones,
  convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 },
});
const pos = (sym, mv) => ({ symbol: sym, qty: mv / 100, avg_entry_price: 100, current_price: 100, market_value: mv });

test('the placed broker stop is the DERIVED stop that sized the position, not the structural one', async () => {
  at._resetCooldowns();
  // Resistance 18% up → derived stop = 18/3 = 6% (floor 5 doesn't bind). The
  // structural/ATR stop floors at 5%. Sizing and the RR gate use 6% — the broker
  // stop must too: 100 × (1 − 0.06) = 94.00. The pre-fix code placed 95.00.
  const { buys, sells } = await run({
    bridgeOpts: {},
    signals: [bull('GLD', [
      { type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 },
      { type: 'RESISTANCE', level: 118, top: 118 },
    ])],
  });
  assert.strictEqual(buys.length, 1, 'entry must place');
  const stop = sells.find((o) => /stop/i.test(o.type || ''));
  assert.ok(stop, 'a protective stop must be placed');
  assert.strictEqual(stop.stopPrice, 94, `stop must sit at the derived 6% distance (got ${stop.stopPrice})`);
  // And the sized qty must agree with the SAME 6% stop: 100k × 0.7% / 6% = $11.6k.
  assert.ok(buys[0].qty * 100 < 12000, `sizing must use the derived stop too (notional $${buys[0].qty * 100})`);
});

test('daily-loss breaker arms on the {dailyPnl} object shape (Alpaca/house/demo)', async () => {
  at._resetCooldowns();
  const { out, buys } = await run({
    bridgeOpts: { dayPnl: { dailyPnl: -5000, unrealizedPnl: -5000, realizedPnl: 0 } },
    signals: [bull('GLD', [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }])],
  });
  assert.strictEqual(buys.length, 0, 'a -5% day on a 2% limit must halt entries');
  assert.ok(out.circuit_breaker, 'circuit breaker must be reported');
  assert.ok(out.skipped.some((s) => /daily-loss/.test(s.why)), 'skip reason must say daily-loss');
});

test('daily-loss breaker still arms on the bare-number shape (IBKR), and a profitable object does not halt', async () => {
  at._resetCooldowns();
  const a = await run({
    bridgeOpts: { dayPnl: -5000 },
    signals: [bull('GLD', [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }])],
  });
  assert.strictEqual(a.buys.length, 0, 'numeric day P&L must still halt');
  at._resetCooldowns();
  const b = await run({
    bridgeOpts: { dayPnl: { dailyPnl: 500 } },
    signals: [bull('TLT', [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }])],
  });
  assert.strictEqual(b.buys.length, 1, 'a profitable day must not halt');
});

test('two same-scan entries cannot stack past the gross cap', async () => {
  at._resetCooldowns();
  // $60k held on $100k equity, cap 80% → $80k budget. Each entry sizes to $14k
  // (0.7% risk at the 5% floor). First: 60+14=74 ≤ 80 → places. Second must see
  // the first's in-scan notional (74+14=88 > 80) and be refused — pre-fix, both
  // compared against the stale $60k snapshot and placed.
  const { buys, out } = await run({
    bridgeOpts: { positions: [pos('SPY', 60000)] },
    signals: [
      bull('GLD', [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }]),
      bull('TLT', [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }]),
    ],
    env: { TRADER_MAX_GROSS_PCT: '80' },
  });
  assert.strictEqual(buys.length, 1, `only the first entry fits the budget (placed: ${buys.map((b) => b.ticker)})`);
  assert.ok(out.skipped.some((s) => s.symbol === 'TLT' && /cash reserve/.test(s.why)),
    `second entry must be refused by the cash reserve, got: ${JSON.stringify(out.skipped)}`);
});

test('an in-flight exit whose order died at the broker un-freezes after two order-less scans + debounce', async () => {
  at._resetCooldowns();
  const T0 = 1_700_000_000_000;
  const held = [pos('EFA', 20000)];
  const bear = { symbol: 'EFA', direction: 'BEARISH', entry_price: 100, atr: 1, zones: [], convergence: { decision: 'ENTER', p_win: 0.9, size_mult: 1 } };
  const buys = [], sells = [];
  // The re-protect pass adds a GTC protective STOP for the naked long every scan
  // (the stub broker never persists orders) — those are not exits. Count only the
  // signal-exit sells.
  const exits = () => sells.filter((o) => !/stop/i.test(o.type || ''));
  // Scan 1: strong bearish → signal exit fires; the broker parks it (needs_confirmation).
  const s1 = await run({ bridgeOpts: { positions: held, buys, sells, sellStatus: 'needs_confirmation' }, signals: [bear], now: T0 });
  assert.strictEqual(exits().length, 1, 'scan 1 places the exit');
  assert.ok(s1.out.executed.some((e) => e.action === 'exit_long'), 'exit_long recorded');
  // Scan 2 (+9 min): the parked order no longer exists at the broker (openOrders
  // empty), position still held. First miss → still frozen, no new exit.
  const s2 = await run({ bridgeOpts: { positions: held, buys, sells, sellStatus: 'needs_confirmation' }, signals: [bear], now: T0 + 9 * 60000 });
  assert.strictEqual(exits().length, 1, 'scan 2 stays frozen (single miss)');
  assert.ok(s2.out.skipped.some((x) => /oversell guard|exit already fired/.test(x.why)), 'scan 2 skip is the freeze');
  // Scan 3 (+10 min): second consecutive miss AND past the 8-min debounce → the
  // freeze releases and the exit re-fires. Pre-fix this position was stranded
  // from every engine exit until it left the book.
  await run({ bridgeOpts: { positions: held, buys, sells, sellStatus: 'needs_confirmation' }, signals: [bear], now: T0 + 10 * 60000 });
  assert.strictEqual(exits().length, 2, 'scan 3 un-freezes and re-fires the exit');
  const log = fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8');
  assert.ok(/exit_unfrozen/.test(log), 'the release is narrated in the ledger');
});
