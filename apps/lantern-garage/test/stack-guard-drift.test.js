'use strict';
/**
 * stack-guard-drift.test.js — two findings from the SPY investigation (#3432).
 *
 *  STACKING GUARD: on 2026-08-17 the orders feed went blind to working stops
 *  and the re-protect pass placed a fresh stop every scan — fifteen deep on
 *  SPY and QQQ. The per-order status endpoint can see a registered stop the
 *  feed cannot; a working answer means "feed blind", not "naked".
 *
 *  POSITION DRIFT: SPY grew 75 -> 76 -> 77 -> 78 on three opens with no entry
 *  row anywhere. A held quantity that changes with no engine order in the last
 *  10 minutes is journaled with the broker orders the feed shows.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stackdrift-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
delete process.env.TRADER_AUTO_EXECUTE;
delete process.env.TRADER_BE_RATCHET;
// HERMETIC EXITS (2026-08-25). These fixtures hold a position in "LNG" — a REAL
// ticker — and the engine's market-data-driven exits fetch live bars for whatever
// symbol it is holding. So with those exits at their defaults the suite's verdict
// depends on Cheniere Energy's intraday MACD/RSI: CI was green at 14:49 ET and red
// at 15:58 ET the same afternoon, with be-ratchet losing 6 tests and eod-flat 4 to
// a `momentum_died (MACD hist<0, <EMA9, RSI 40)` exit that closed the position out
// from under the behaviour being tested. Pinning the five exit-authority switches
// to their ARMED production values (#3437/#3438) makes the fixture deterministic
// AND more faithful to the engine that actually runs. A test about the stop-stacking guard must
// not be able to fail because a real stock moved.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

function world({ heldQty = 75, lastQty = 75, stopOrders = null, feedOrders = [], status = null } = {}) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: lastQty, entry: 100, mark: 100, ts: Date.now() - 60e3 } },
    stopDistPct: { LNG: 3 },
    ...(stopOrders ? { stopOrders } : {}),
  }));
  at._loadState();
  const placed = [], statusCalls = [];
  const bridge = {
    placed, statusCalls,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: heldQty, avg_entry_price: 100, current_price: 100, market_value: 100 * heldQty, unrealized_pl: 0 }],
    getIBKROpenOrders: async () => [...feedOrders],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async (uid, id) => { statusCalls.push(id); return status ? status(id) : null; },
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'NEW-' + placed.length }; },
  };
  return bridge;
}

// The feed is PARTIAL in every guard case: another symbol's stop is listed, ours is not.
// (A feed with ZERO orders while holding is treated as unreadable and re-protect is
// deferred — that path is already safe; 8/17 stacked because the feed was partial.)
test('STACKING GUARD: feed shows no stop, but the registered stop reports WORKING -> nothing is placed', async () => {
  const bridge = world({ stopOrders: { LNG: { id: 'S1', px: 97, qty: 75, at: Date.now() - 3600e3 } }, feedOrders: [{ orderId: 'Z1', symbol: 'OTHER', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 10, qty: 5 }],
    status: (id) => (id === 'S1' ? { order_id: id, status: 'Submitted' } : null) });
  const out = await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.deepStrictEqual(bridge.statusCalls, ['S1'], 'asked the broker about OUR stop before re-placing');
  assert.strictEqual(bridge.placed.filter((o) => o.type === 'stop').length, 0, 'no stacked stop');
  assert.ok((out.skipped || []).some((s) => /feed blind/.test(String(s.why))), 'the skip says why');
});

test('STACKING GUARD: the registered stop reports CANCELLED -> the position IS naked, one stop is placed', async () => {
  const bridge = world({ stopOrders: { LNG: { id: 'S1', px: 97, qty: 75, at: Date.now() - 3600e3 } }, feedOrders: [{ orderId: 'Z1', symbol: 'OTHER', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 10, qty: 5 }],
    status: (id) => (id === 'S1' ? { order_id: id, status: 'Cancelled' } : null) });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.placed.filter((o) => o.type === 'stop').length, 1, 'exactly one replacement stop');
});

test('STACKING GUARD: no registry entry -> the old path (a stop is placed when the feed shows none)', async () => {
  const bridge = world({ feedOrders: [{ orderId: 'Z1', symbol: 'OTHER', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 10, qty: 5 }] });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.statusCalls.length, 0, 'nothing to ask about');
  assert.strictEqual(bridge.placed.filter((o) => o.type === 'stop').length, 1);
});

test('POSITION DRIFT: held 76 where the engine knew 75, no engine order -> a position_drift row with the feed orders', async () => {
  const bridge = world({ heldQty: 76, lastQty: 75, stopOrders: { LNG: { id: 'S1', px: 97, qty: 75, at: Date.now() - 3600e3 } },
    feedOrders: [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 97, qty: 75 },
      { orderId: 'X9', symbol: 'LNG', side: 'buy', orderType: 'Limit', status: 'Filled', price: 99.5, qty: 1 }],
    status: (id) => ({ order_id: id, status: 'Submitted' }) });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  const drift = readRows().filter((r) => r.event === 'position_drift');
  assert.strictEqual(drift.length, 1, 'one drift row');
  assert.strictEqual(drift[0].symbol, 'LNG');
  assert.strictEqual(drift[0].qty_was, 75);
  assert.strictEqual(drift[0].qty_now, 76);
  assert.strictEqual(drift[0].delta, 1);
  assert.ok(/phantom buy/.test(drift[0].reason));
  assert.ok(drift[0].feed_orders.some((o) => o.id === 'X9' && o.side === 'buy'), 'the feed order that could explain it is attached');
});

test('POSITION DRIFT: a steady quantity journals nothing', async () => {
  const bridge = world({ heldQty: 75, lastQty: 75, feedOrders: [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 97, qty: 75 }] });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(readRows().filter((r) => r.event === 'position_drift').length, 0);
});
