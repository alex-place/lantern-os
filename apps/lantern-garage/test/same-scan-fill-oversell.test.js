'use strict';
/**
 * same-scan-fill-oversell.test.js — the SAME-SCAN FILL GUARD (2026-10-16).
 *
 * Live on stable (IBKR paper) 2026-10-16: XLE's step-floor stop (2,628 @ 67.37) filled at 09:40:48. The 09:42:03 scan
 * booked that fill from the orders feed, but its positions snapshot (read first, and IBKR's positions endpoint lags the
 * orders feed) still showed 2,628 held. The ratchet saw no WORKING stop (a filled order is not working), raised a new
 * 2,628-share stop at the same level, the re-protect pass placed it, and it filled at 09:42:06: the account went SHORT
 * 2,628 XLE (~$179k) into the weekend. A sell the orders read shows FILLED this scan must not get another sell this scan.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'samescanfill-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
// Hermetic exits, as step-floor.test.js: the fixture holds a REAL ticker, so the market-data-driven exits are pinned
// to their armed production values and cannot close the position out from under the behaviour being tested.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

/** LNG held 100 @ entry 100, marked at 101.2 (+1.2%: the 1% step floor wants a stop at 101). `orders` = the feed. */
function world(orders) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark: 101.2, ts: Date.now() } } }));
  at._loadState();
  const placed = [], cancelled = [];
  const bridge = {
    placed, cancelled,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    // the positions endpoint lags: it still reports the 100 shares the filled stop already sold
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: 101.2, market_value: 10120, unrealized_pl: 120 }],
    getIBKROpenOrders: async () => orders.filter((o) => !cancelled.includes(o.orderId)),   // a cancelled order leaves the feed
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => { cancelled.push(id); return { status: 'cancelled' }; },
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
  return bridge;
}
const scan = { signals: [] };
const lngSells = (b) => b.placed.filter((o) => String(o.ticker || o.symbol).toUpperCase() === 'LNG' && /sell/i.test(String(o.side)));

test('a stop the orders feed shows FILLED this scan gets NO new sell this scan, even if the positions snapshot still shows the shares', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    const filledStop = { orderId: 'F1', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Filled', qty: 100, price: 101,
      filledQty: 100, avgPrice: 101, filledAt: new Date().toISOString() };
    const b = world([filledStop]);
    await at.runAutoTrade(scan, { bridge: b, userId: 't' });
    const exits = rows().filter((r) => r.event === 'exit' && r.symbol === 'LNG');
    assert.strictEqual(exits.length, 1, 'the fill is booked once, from the feed');
    assert.strictEqual(exits[0].order_id, 'F1');
    assert.strictEqual(lngSells(b).length, 0, `no second sell for shares already sold (placed: ${JSON.stringify(lngSells(b))})`);
    assert.strictEqual(rows().filter((r) => r.event === 'stop_resize' && r.symbol === 'LNG').length, 0, 'no ratchet on a position that just left the book');
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});

test('control: with NO fill in the feed the same position still gets its stop raised (the guard is per-fill, not a blanket skip)', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    const working = { orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 97, qty: 100 };
    const b = world([working]);
    await at.runAutoTrade(scan, { bridge: b, userId: 't' });
    const r = rows().filter((x) => x.event === 'stop_resize' && x.symbol === 'LNG');
    assert.strictEqual(r.length, 1, 'the step floor raises the stop');
    assert.strictEqual(r[0].stop_want, 101);
    assert.deepStrictEqual(b.cancelled, ['S1'], 'the low stop is cancelled');
    assert.strictEqual(lngSells(b).length, 1, 'and exactly one new stop is placed');
    assert.strictEqual(Number(lngSells(b)[0].qty), 100);
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});
