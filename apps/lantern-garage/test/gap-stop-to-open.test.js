'use strict';
/**
 * gap-stop-to-open.test.js — TRADER_GAP_STOP_TO_OPEN (2026-10-15 cost audit, operator: "do the fixes").
 *
 * A protective stop that the PRE-MARKET already trades through fires on the opening print and fills as a
 * market order in the first seconds after it, under the official open: GDX 2026-10-15 filled 84.62 against
 * an 84.78 open, and five stable stops since 09-01 filled $1.0k under their opens. Inside the pre-open
 * window the position is handed to the opening auction instead (cancel the stop, market-on-open sell).
 * If the broker refuses the auction order the stop goes back at its original level. A stop must never be
 * stacked on top of a working auction sell (that would oversell into a short).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gapopen-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
// Hermetic exits (see step-floor.test.js): the fixture holds a real ticker, so pin the market-data exits off.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const AT_0925 = Date.parse('2026-10-16T13:25:00Z');   // Friday 09:25 ET
const AT_0910 = Date.parse('2026-10-16T13:10:00Z');   // Friday 09:10 ET (before the window)
const scan = { signals: [] };

/** A held long at entry 100, pre-market mark `mark`, a working stop at `stopPx`; the broker book is mutable. */
function world({ mark, stopPx = 97, opgFails = false }) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark, ts: Date.now() } } }));
  at._loadState();
  let orders = [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: stopPx, qty: 100 }];
  const placed = [], cancelled = [];
  return {
    placed, cancelled,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: mark, market_value: 100 * mark, unrealized_pl: (mark - 100) * 100 }],
    getIBKROpenOrders: async () => orders.slice(),
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => { cancelled.push(id); orders = orders.filter((o) => o.orderId !== id); return { status: 'cancelled', ok: true }; },
    placeIBKROrder: async (uid, o) => {
      placed.push(o);
      if (o.timeInForce === 'opg' && opgFails) return { status: 'error', reason: 'OPG refused by the broker' };
      const id = 'X' + placed.length;
      orders.push({ orderId: id, symbol: o.ticker, side: o.side, orderType: o.type === 'stop' ? 'Stop' : 'Market', status: 'Submitted', price: o.stopPrice || null, qty: o.qty });
      return { status: 'placed', order_id: id };
    },
  };
}

test('a pre-market mark under the stop at 09:25: the stop is cancelled and a market-on-open sell goes out', async () => {
  process.env.TRADER_GAP_STOP_TO_OPEN = '1';
  try {
    const b = world({ mark: 95 });
    await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0925, extended: true, protectiveOnly: true });
    assert.deepStrictEqual(b.cancelled, ['S1'], 'the resting stop is cancelled');
    const opg = b.placed.filter((o) => o.timeInForce === 'opg');
    assert.strictEqual(opg.length, 1, 'one auction order');
    assert.strictEqual(opg[0].type, 'market');
    assert.strictEqual(opg[0].side, 'sell');
    assert.strictEqual(opg[0].qty, 100);
    assert.strictEqual(b.placed.filter((o) => o.type === 'stop').length, 0, 'no stop stacked on the auction order');
    const ev = rows().filter((r) => r.event === 'gap_stop_to_open');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].stop, 97);
    // the next pre-open scan neither hands it over again nor re-protects it
    await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0925 + 60000, extended: true, protectiveOnly: true });
    assert.strictEqual(b.placed.length, 1, 'nothing more is placed while the auction order works');
  } finally { delete process.env.TRADER_GAP_STOP_TO_OPEN; }
});

test('the auction order refused: the stop goes back at its ORIGINAL level in the same scan', async () => {
  process.env.TRADER_GAP_STOP_TO_OPEN = '1';
  try {
    const b = world({ mark: 95, opgFails: true });
    await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0925, extended: true, protectiveOnly: true });
    assert.deepStrictEqual(b.cancelled, ['S1']);
    const stops = b.placed.filter((o) => o.type === 'stop');
    assert.strictEqual(stops.length, 1, 'exactly one stop goes back');
    assert.strictEqual(stops[0].stopPrice, 97, 'at the original level, not re-clamped under the pre-market mark');
    assert.strictEqual(rows().filter((r) => r.event === 'gap_stop_to_open_failed').length, 1);
  } finally { delete process.env.TRADER_GAP_STOP_TO_OPEN; }
});

test('nothing happens when the mark is above the stop, before the window, or with the knob off', async () => {
  process.env.TRADER_GAP_STOP_TO_OPEN = '1';
  try {
    let b = world({ mark: 98 });
    await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0925, extended: true, protectiveOnly: true });
    assert.strictEqual(b.cancelled.length + b.placed.length, 0, 'mark above the stop');
    b = world({ mark: 95 });
    await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0910, extended: true, protectiveOnly: true });
    assert.strictEqual(b.cancelled.length + b.placed.length, 0, 'before 09:20 ET');
  } finally { delete process.env.TRADER_GAP_STOP_TO_OPEN; }
  const b = world({ mark: 95 });
  await at.runAutoTrade(scan, { bridge: b, userId: 't', now: AT_0925, extended: true, protectiveOnly: true });
  assert.strictEqual(b.cancelled.length + b.placed.length, 0, 'knob off = the old behaviour');
});
