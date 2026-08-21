'use strict';
/**
 * be-ratchet.test.js — the breakeven ratchet (#3413 lab → engine).
 *
 * The lab result this enforces: once a held long has been up TRADER_BE_RATCHET
 * (+2% validated), its protective stop rises to ENTRY and never lowers — the
 * worst path a 2%-up position can take becomes a round trip, not a −3% loser.
 * Validated on all four lab surfaces with slippage charged; the re-entry policy
 * validated with it is SESSION-scoped: a breakeven fill blocks the symbol for
 * the rest of the session only and does NOT feed the daily breaker (the
 * loss-reduction lab REJECTED broader stand-downs).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beratchet-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
delete process.env.TRADER_AUTO_EXECUTE;
delete process.env.TRADER_BE_RATCHET;

const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** A held long, up `upPct` from entry, with (optionally) a working GTC stop. */
function world({ upPct = 0.025, stopPx = 97, stopId = 'S1', withStop = true, beStopAt = null } = {}) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 100 * (1 + upPct), ts: Date.now() } },
    stopDistPct: { LNG: 3 },
    ...(withStop ? { stopOrders: { LNG: { id: stopId, px: stopPx, qty: 100, at: Date.now() } } } : {}),
    ...(beStopAt ? { beStopAt } : {}),
  }));
  at._loadState();
  const orders = withStop
    ? [{ orderId: stopId, symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: stopPx, qty: 100 }]
    : [];
  const placed = [], cancelled = [];
  const bridge = {
    placed, cancelled,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100,
      current_price: 100 * (1 + upPct), market_value: 100 * 100 * (1 + upPct), unrealized_pl: 100 * 100 * upPct }],
    getIBKROpenOrders: async () => [...orders],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => {
      cancelled.push(String(id));
      const i = orders.findIndex((o) => String(o.orderId) === String(id));
      if (i >= 0) orders.splice(i, 1);
      return { status: 'cancelled' };
    },
    placeIBKROrder: async (uid, o) => {
      placed.push(o);
      const r = { orderId: 'NEW-' + placed.length, symbol: o.ticker, side: o.side,
        orderType: o.type, status: 'Submitted', price: o.stopPrice, qty: o.qty };
      orders.push(r);
      return { status: 'submitted', order_id: r.orderId };
    },
  };
  return bridge;
}

test('DEFAULT OFF: up 2.5% with a low stop, env unset — nothing moves', async () => {
  delete process.env.TRADER_BE_RATCHET;
  const bridge = world({});
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.cancelled.length, 0, 'no cancels');
  assert.ok(!readRows().some((r) => /be_ratchet/.test(String(r.reason || ''))), 'no be_ratchet rows');
  assert.ok(!at._beStopAt.has('LNG'), 'no ratchet state');
});

test('RATCHET FIRES: up 2.5% >= +2% — low stop cancelled, new stop placed AT entry, journaled', async () => {
  process.env.TRADER_BE_RATCHET = '0.02';
  const bridge = world({});
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.deepStrictEqual(bridge.cancelled, ['S1'], 'the 97 stop was cancelled');
  const stops = bridge.placed.filter((o) => o.ticker === 'LNG' && o.type === 'stop');
  assert.strictEqual(stops.length, 1, 'exactly one replacement stop');
  assert.strictEqual(stops[0].stopPrice, 100, 'placed AT entry');
  assert.strictEqual(stops[0].qty, 100);
  const rz = readRows().filter((r) => r.event === 'stop_resize' && /be_ratchet/.test(r.reason));
  assert.strictEqual(rz.length, 1, 'one be_ratchet stop_resize row');
  assert.strictEqual(rz[0].stop_was, 97);
  assert.strictEqual(rz[0].stop_want, 100);
  assert.strictEqual(readState().beStopAt.LNG, 100, 'ratchet level persisted');
});

test('IDEMPOTENT: second scan after the ratchet — no further cancels or rows', async () => {
  process.env.TRADER_BE_RATCHET = '0.02';
  const bridge = world({ stopPx: 100, beStopAt: { LNG: 100 } });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.cancelled.length, 0, 'entry-level stop left alone');
  assert.strictEqual(bridge.placed.filter((o) => o.type === 'stop').length, 0, 'nothing re-placed');
  assert.ok(!readRows().some((r) => r.event === 'stop_resize'), 'no duplicate journal rows');
});

test('NEVER LOWERS: a stop already ABOVE entry is recorded, not replaced', async () => {
  process.env.TRADER_BE_RATCHET = '0.02';
  const bridge = world({ upPct: 0.025, stopPx: 101 });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.cancelled.length, 0, 'higher stop untouched');
  assert.strictEqual(at._beStopAt.get('LNG'), 101, 'the higher level is the recorded floor');
  assert.ok(!readRows().some((r) => r.event === 'stop_resize'), 'no resize journaled');
});

test('BELOW TRIGGER: up only 1% — untouched', async () => {
  process.env.TRADER_BE_RATCHET = '0.02';
  const bridge = world({ upPct: 0.01 });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(bridge.cancelled.length, 0);
  assert.ok(!at._beStopAt.has('LNG'));
});

test('BE FILL: ratcheted stop fills — round trip, session block only, breaker untouched', async () => {
  process.env.TRADER_BE_RATCHET = '0.02';
  // Engine state: ratcheted, registered stop at entry. Broker: position GONE,
  // feed silent, only the per-order status endpoint knows it filled (#3379 path).
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: {
      LNG: { qty: 100, entry: 100, mark: 100.2, ts: Date.now() },
      ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() },
    },
    stopDistPct: { LNG: 3 },
    stopOrders: { LNG: { id: 'S9', px: 100, qty: 100, at: Date.now() - 3600e3 } },
    beStopAt: { LNG: 100 },
  }));
  at._loadState();
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async (uid, id) => (id === 'S9'
      ? { order_id: id, status: 'Filled', avgPrice: 99.97, filledQty: 100 } : null),
  };
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // absence 1: deferred (#3378)
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // absence 2: reconcile + book

  const exits = readRows().filter((r) => r.event === 'exit');
  assert.strictEqual(exits.length, 1);
  assert.match(exits[0].reason, /protective_stop/, 'still a protective-stop booking');
  assert.match(exits[0].reason, /be_ratchet/, 'flagged as the ratchet round trip');
  assert.strictEqual(exits[0].be_ratchet, true);
  assert.strictEqual(exits[0].exit, 99.97, 'priced at the fill');
  const st = readState();
  assert.strictEqual(st.stopCooldownThrough.LNG, todayET(), 'blocked for the REST OF THE SESSION only');
  assert.strictEqual((st.stopFills && st.stopFills.count) || 0, 0, 'daily breaker NOT fed by a round trip');
  assert.ok(!(st.beStopAt && st.beStopAt.LNG), 'ratchet state consumed by the fill');
});

test('RESTART SURVIVAL: the ratchet map round-trips through _saveState/_loadState', async () => {
  at._resetCooldowns();
  at._beStopAt.set('LNG', 123.45);
  at._saveState();
  at._beStopAt.clear();
  at._loadState();
  assert.strictEqual(at._beStopAt.get('LNG'), 123.45);
});
