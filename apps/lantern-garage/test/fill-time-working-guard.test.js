'use strict';
/**
 * fill-time-working-guard.test.js — a fill is not dated before a moment the order was seen still working (2026-10-30).
 *
 * IBKR's order list reports lastExecutionTime_r for a GTC stop as its SUBMISSION (or last modify): GLD's stop went in
 * with its 10-29 11:26 ET entry and filled 10-30 ~10:25 ET, and the exit row was stamped 10-29 11:26:21 — the second of
 * the entry. GDX the same (placed 10-22 12:08, filled 10-23 ~10:17). Those exits fell out of their own day's session
 * record (10-30: stops_fired 0 with the GLD stop) and per-trade P&L matched by timestamp went to the wrong trades.
 * The brain now remembers when each order was last seen working; a reported execution time no later than that is not
 * the fill's, so the row is stamped at its discovery and keeps the broker's value as broker_time. Alpaca's filledAt
 * (after the last working sighting) still wins, and with no sighting nothing changes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TRADER_TRADES_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fill-time-guard-')), 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(path.dirname(process.env.TRADER_TRADES_LOG), 'state.json');
const { newExitRows } = require('../lib/fill-ledger');
const at = require('../lib/auto-trader');

const PLACED = Date.parse('2026-10-29T15:26:21Z');            // GLD's entry and its stop, 11:26:21 ET
const GLD_FILL = { orderId: '2092097934', symbol: 'GLD', side: 'SELL', orderType: 'Stop', qty: 158, filledQty: 158, avgPrice: 357.25, status: 'Filled', price: 357.32, time: PLACED };
const readRows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG) ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);

test('fill ledger: an execution time no later than a working sighting is stamped at discovery, the broker value kept', () => {
  const seen = Date.parse('2026-10-30T14:24:30Z');           // a 10:24 ET scan still saw the stop working
  const before = Date.now();
  const rows = newExitRows([GLD_FILL], new Set(), () => ({ avg_entry_price: 368.4163323, openedAt: PLACED - 1000 }), 0,
    { seenWorkingAt: (id) => (id === '2092097934' ? seen : null) });
  assert.strictEqual(rows.length, 1);
  assert.ok(Date.parse(rows[0].ts) >= before, `stamped at discovery, got ${rows[0].ts}`);
  assert.strictEqual(rows[0].discovered_at, rows[0].ts);
  assert.strictEqual(rows[0].broker_time, '2026-10-29T15:26:21.000Z');
  assert.strictEqual(rows[0].ts_from, 'discovered');
  assert.ok(Math.abs(rows[0].pnl - (-1764.28)) < 0.05, `pnl ${rows[0].pnl}`);
});

test('fill ledger: a fill time AFTER the last working sighting wins (Alpaca filledAt); without a sighting nothing changes', () => {
  const seen = Date.parse('2026-10-30T14:00:00Z'), filled = Date.parse('2026-10-30T14:00:41Z');
  const alp = { orderId: 'a1', symbol: 'SPY', side: 'SELL', orderType: 'stop', filledQty: 7, avgPrice: 759.64, status: 'filled', filledAt: new Date(filled).toISOString() };
  const r1 = newExitRows([alp], new Set(), () => ({ avg_entry_price: 769.12 }), 0, { seenWorkingAt: () => seen });
  assert.strictEqual(r1[0].ts, new Date(filled).toISOString());
  assert.strictEqual(r1[0].ts_from, undefined);
  assert.strictEqual(r1[0].broker_time, undefined);
  const r2 = newExitRows([GLD_FILL], new Set(), () => ({ avg_entry_price: 368.4163323 }), 0);
  assert.strictEqual(r2[0].ts, '2026-10-29T15:26:21.000Z', 'no sighting (no option): the broker time, as before');
  const r3 = newExitRows([GLD_FILL], new Set(), () => ({ avg_entry_price: 368.4163323 }), 0, { seenWorkingAt: () => null });
  assert.strictEqual(r3[0].ts, '2026-10-29T15:26:21.000Z', 'an order never seen working: the broker time');
});

test('brain: a stop seen working at one scan and filled by the next is booked at its discovery, and the sighting survives a restart', async () => {
  at._resetCooldowns();
  const scan1 = Date.parse('2026-10-30T14:24:30Z'), scan2 = Date.parse('2026-10-30T14:25:34Z');   // Fri 10:24 / 10:25 ET
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { GLD: { qty: 158, entry: 368.4163323, mark: 358.5, ts: scan1 - 60000 } },
    entryAt: { GLD: PLACED - 1000 },
    stopDistPct: { GLD: 3 },
    stopOrders: { GLD: { id: '2092097934', px: 357.32, qty: 158, at: PLACED } },
  }));
  at._loadState();
  const env = { A: process.env.TRADER_AUTO_EXECUTE, M: process.env.TRADER_MANAGE_EXITS };
  process.env.TRADER_AUTO_EXECUTE = '1'; process.env.TRADER_MANAGE_EXITS = '1';
  const working = { ...GLD_FILL, filledQty: 0, avgPrice: null, status: 'Submitted' };
  let book = [{ symbol: 'GLD', qty: 158, avg_entry_price: 368.4163323, current_price: 358.5, market_value: 158 * 358.5 }];
  let orders = [working];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 970000, mode: 'paper' }),
    getIBKRPositions: async () => book.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => orders.map((o) => ({ ...o })),
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    placeIBKROrder: async () => { throw new Error('no broker writes expected'); },
    cancelIBKROrder: async () => { throw new Error('no broker writes expected'); },
  };
  try {
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't', now: scan1 });
    const st = JSON.parse(fs.readFileSync(process.env.TRADER_STATE_FILE, 'utf8'));
    assert.strictEqual(st.ordersSeenWorking && st.ordersSeenWorking['2092097934'], scan1, 'the working sighting is persisted');
    assert.strictEqual(readRows().filter((r) => r.event === 'exit').length, 0, 'nothing filled yet');
    // the stop fills between the scans; the feed reports the fill with the stop's submission time
    book = []; orders = [GLD_FILL];
    const before = Date.now();
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't', now: scan2 });
    const ex = readRows().filter((r) => r.event === 'exit' && r.symbol === 'GLD');
    assert.strictEqual(ex.length, 1, 'one exit row');
    assert.ok(Date.parse(ex[0].ts) >= before, `booked at its discovery, not 10-29: ${ex[0].ts}`);
    assert.strictEqual(ex[0].ts_from, 'discovered');
    assert.strictEqual(ex[0].broker_time, '2026-10-29T15:26:21.000Z');
    assert.ok(Math.abs(ex[0].pnl - (-1764.28)) < 0.05, `pnl ${ex[0].pnl}`);
  } finally {
    if (env.A == null) delete process.env.TRADER_AUTO_EXECUTE; else process.env.TRADER_AUTO_EXECUTE = env.A;
    if (env.M == null) delete process.env.TRADER_MANAGE_EXITS; else process.env.TRADER_MANAGE_EXITS = env.M;
  }
});
