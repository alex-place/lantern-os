'use strict';
/**
 * stop-reconciliation.test.js — a broker-side stop fill is a STOP, not a mystery
 * (#3379).
 *
 * The real case, 2026-08-19: SMH's ladder stop — a GTC placed 08-18 — filled at
 * 10:12 for -$3,170. The orders feed never listed the fill (prior-session GTC),
 * so the reconciler saw nothing and the sweep booked `closed_externally`,
 * mark-priced and `estimated`. Three subsystems then disagreed about one event:
 * the exit row said "external", the session said stops_fired 0, and the
 * post-stop cooldown armed anyway. The reviewer flagged the contradiction.
 *
 * The fix: the engine REMEMBERS the order id of every protective stop it
 * places (persisted — a GTC outlives the process by design), and when a
 * position vanishes it asks the per-order status endpoint about ITS OWN stop
 * before inventing a reconstruction.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stoprec-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
delete process.env.TRADER_AUTO_EXECUTE;

const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const ANCHOR = { symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 };

/** The SMH shape: engine state says we hold it + we placed stop id S1; the
 *  broker book no longer shows it; the orders FEED is silent (prior-session
 *  GTC); only the per-order status endpoint knows the truth. */
function seedSmh({ stopOrders }) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: {
      SMH: { qty: 203, entry: 576.40500295, mark: 563.0, ts: Date.now() },
      ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() },
    },
    stopDistPct: { SMH: 3 },
    ...(stopOrders ? { stopOrders } : {}),
  }));
  at._loadState();
}

function bridgeWith({ orderStatus, orders = [] }) {
  const statusCalls = [];
  return {
    statusCalls,
    getIBKRAccount: async () => ({ equity: 970000, mode: 'paper' }),
    getIBKRPositions: async () => [{ ...ANCHOR }],
    getIBKROpenOrders: async () => orders,
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async (uid, id) => { statusCalls.push(id); return orderStatus(id); },
  };
}

test('THE SMH CASE: a feed-invisible GTC stop fill books as a real stop exit, priced at the fill', async () => {
  seedSmh({ stopOrders: { SMH: { id: '318419001', px: 561.2, qty: 203, at: Date.now() - 86400e3 } } });
  const bridge = bridgeWith({
    orderStatus: (id) => (id === '318419001'
      ? { order_id: id, status: 'Filled', avgPrice: 560.7883911, filledQty: 203 } : null),
  });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // absence 1: deferred (#3378)
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // absence 2: reconcile + book

  const exits = readRows().filter((r) => r.event === 'exit');
  assert.strictEqual(exits.length, 1, 'exactly one exit row');
  const e = exits[0];
  assert.match(e.reason, /protective_stop/, 'classified as OUR stop, not closed_externally');
  assert.strictEqual(e.order_id, '318419001', 'carries the real order id');
  assert.strictEqual(e.exit, 560.7883911, 'priced at the FILL, not the last mark (563.0)');
  assert.strictEqual(e.pnl, +((560.7883911 - 576.40500295) * 203).toFixed(2));
  assert.strictEqual(e.status, 'filled');
  assert.strictEqual(e.estimated, false, 'a fill price is not an estimate');
  assert.strictEqual(bridge.statusCalls.length, 1, 'one lookup, on the booking scan only');

  // the whole accounting chain agrees now: cooldown armed AND breaker ticked
  const st = readState();
  assert.ok(st.stopCooldownThrough && st.stopCooldownThrough.SMH, 'post-stop cooldown armed');
  assert.strictEqual(st.stopFills.count, 1, 'the daily breaker counted the stop');
  assert.ok(!(st.stopOrders && st.stopOrders.SMH), 'the consumed registry entry is gone');
});

test('the registry SURVIVES a restart — the whole point of persisting it', async () => {
  // seedSmh writes stopOrders into the state file and _loadState restores it;
  // this pins the round-trip explicitly so a lost restore can never regress
  // silently: the id must be queryable in a fresh "process".
  seedSmh({ stopOrders: { SMH: { id: '318419002', px: 561.2, qty: 203, at: Date.now() } } });
  assert.strictEqual(at._stopOrders.get('SMH').id, '318419002', 'restored from disk into the registry');
  at._saveState();
  assert.strictEqual(readState().stopOrders.SMH.id, '318419002', 'and saved back out');
});

test('an UNFILLED stop does not classify: the honest reconstruction remains, annotated', async () => {
  seedSmh({ stopOrders: { SMH: { id: '318419003', px: 561.2, qty: 203, at: Date.now() } } });
  const bridge = bridgeWith({
    orderStatus: () => ({ order_id: '318419003', status: 'Cancelled', avgPrice: null, filledQty: null }),
  });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });

  const e = readRows().find((r) => r.event === 'exit');
  assert.ok(e, 'still booked — the position really left');
  assert.match(e.reason, /closed_externally/, 'a cancelled stop explains nothing — stay honest');
  assert.strictEqual(e.status, 'reconstructed');
  assert.strictEqual(e.stop_order_id, '318419003', 'the row records which stop was checked');
  assert.strictEqual(e.stop_order_status, 'Cancelled', '...and what the broker said about it');
});

test('a DEAD status endpoint degrades to exactly the old behavior', async () => {
  seedSmh({ stopOrders: { SMH: { id: '318419004', px: 561.2, qty: 203, at: Date.now() } } });
  const bridge = bridgeWith({ orderStatus: () => { throw new Error('socket hang up'); } });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });

  const e = readRows().find((r) => r.event === 'exit');
  assert.ok(e, 'the reconstruction path still runs');
  assert.match(e.reason, /closed_externally/);
  assert.strictEqual(e.stop_order_status, 'unavailable', 'the failed lookup is recorded, not hidden');
});

test('NO registry entry → no lookup, byte-for-byte the pre-#3379 path', async () => {
  seedSmh({ stopOrders: null });
  const bridge = bridgeWith({ orderStatus: () => { throw new Error('must never be called'); } });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });

  const e = readRows().find((r) => r.event === 'exit');
  assert.ok(e && /closed_externally/.test(e.reason));
  assert.strictEqual(bridge.statusCalls.length, 0, 'no id to ask about, no call made');
  assert.strictEqual(e.stop_order_id, null);
});

test('SAME-SESSION path unchanged: a feed-visible fill books via the reconciler, one row, registry consumed', async () => {
  seedSmh({ stopOrders: { SMH: { id: '318419005', px: 561.2, qty: 203, at: Date.now() } } });
  const bridge = bridgeWith({
    orderStatus: () => { throw new Error('the feed already answered — no lookup needed'); },
    orders: [{ orderId: '318419005', symbol: 'SMH', side: 'SELL', orderType: 'Stop', status: 'Filled',
      filledQty: 203, avgPrice: 560.7883911, time: Date.now() }],
  });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });

  const exits = readRows().filter((r) => r.event === 'exit');
  assert.strictEqual(exits.length, 1, 'one row from the fill reconciler, none from the sweep');
  assert.strictEqual(exits[0].source, 'fill');
  assert.strictEqual(exits[0].order_id, '318419005');
  assert.strictEqual(bridge.statusCalls.length, 0, 'no per-order lookup when the feed showed the fill');
  assert.ok(!at._stopOrders.has('SMH'), 'registry consumed by the fill row');
  // second scan: the absence is now EXPLAINED — nothing further books
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  assert.strictEqual(readRows().filter((r) => r.event === 'exit').length, 1, 'still one row');
});
