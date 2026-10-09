'use strict';
/**
 * partial-fill-basis.test.js — the last partial of a stop that filled in pieces keeps its entry basis
 * (engine S, SMH, 2026-10-09).
 *
 * A 30-share GTC stop filled 12 / 9 / 9 over three minutes at the open. Each fill row destroyed the
 * per-position state (the ghost-peak rule: the position left the book at this fill), and while the
 * position was still partly held the next sweep re-adopted it from the broker's avg_entry_price, so
 * the first two rows priced fine. The THIRD fill emptied the book: no sweep re-adopted the symbol
 * before the reconcile ran, and the row was journaled with entry:null / pnl:null. The booked realized
 * under-counted the day by the whole partial (+51.35) and the day-P&L page rebuilds from those rows.
 * The brain now remembers the basis it saw while the symbol was held and falls back to it when the
 * position map is empty and no newer entry was placed by this engine.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TRADER_TRADES_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-basis-')), 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(path.dirname(process.env.TRADER_TRADES_LOG), 'state.json');
const at = require('../lib/auto-trader');

const H = 3600e3;
const ENTRY = 606.839;
const readRows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG) ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);
const exits = () => readRows().filter((r) => r.event === 'exit' && r.symbol === 'SMH');
const fill = (id, qty, px) => ({ orderId: id, symbol: 'SMH', side: 'SELL', orderType: 'stop', filledQty: qty, avgPrice: px, status: 'filled', time: new Date().toISOString() });
const pos = (qty, mark) => ({ symbol: 'SMH', qty, avg_entry_price: ENTRY, current_price: mark });

test('brain: a stop that fills in three partials books every partial at the basis, the last one included', async () => {
  at._resetCooldowns();
  const now = Date.now();
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { SMH: { qty: 30, entry: ENTRY, mark: 614.05, ts: now - 12 * H } },
    entryAt: { SMH: now - 20 * H },
    stopDistPct: { SMH: 3 },
  }));
  at._loadState();
  const env = { A: process.env.TRADER_AUTO_EXECUTE, M: process.env.TRADER_MANAGE_EXITS };
  process.env.TRADER_AUTO_EXECUTE = '1'; process.env.TRADER_MANAGE_EXITS = '1';
  let positions = [], orders = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions,
    getIBKROpenOrders: async () => orders,
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    placeIBKROrder: async () => ({ status: 'error', reason: 'no broker writes in this test' }),
    cancelIBKROrder: async () => ({ status: 'error', reason: 'no broker writes in this test' }),
  };
  try {
    // scan 1: the stop took 12 of 30 — the book shows 18, the feed shows the first fill
    positions = [pos(18, 613.5)]; orders = [fill('stop-a', 12, 613.12)];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    let ex = exits();
    assert.strictEqual(ex.length, 1, 'the first partial is booked');
    assert.strictEqual(ex[0].entry, ENTRY); assert.ok(Math.abs(ex[0].pnl - 75.37) < 0.02, `pnl ${ex[0].pnl}`);
    // scan 2: 9 more — the book shows 9 (the sweep re-adopts the still-held position)
    positions = [pos(9, 613.3)]; orders = [orders[0], fill('stop-b', 9, 612.94)];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    ex = exits();
    assert.strictEqual(ex.length, 2, 'the second partial is booked');
    assert.strictEqual(ex[1].entry, ENTRY); assert.ok(Math.abs(ex[1].pnl - 54.91) < 0.02, `pnl ${ex[1].pnl}`);
    // scan 3: the last 9 — the book is EMPTY now, so nothing re-adopts the symbol before the reconcile
    positions = []; orders = [orders[0], orders[1], fill('stop-c', 9, 612.545556)];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    ex = exits();
    assert.strictEqual(ex.length, 3, 'the last partial is booked');
    assert.strictEqual(ex[2].qty, 9); assert.strictEqual(ex[2].exit, 612.545556); assert.strictEqual(ex[2].source, 'fill');
    assert.strictEqual(ex[2].entry, ENTRY, 'the last partial keeps the basis the sweep saw while the symbol was held');
    assert.ok(Math.abs(ex[2].pnl - 51.36) < 0.02, `pnl ${ex[2].pnl} (was null before the fix)`);
    assert.ok(Math.abs(ex[2].pnl_pct - 0.9403) < 0.001, `pnl_pct ${ex[2].pnl_pct}`);
    const booked = ex.reduce((s, r) => s + Number(r.pnl || 0), 0);
    assert.ok(Math.abs(booked - 181.64) < 0.05, `the day's booked realized ${booked} = all three partials`);
    // scan 4: the same empty book and the same feed — nothing double-books, nothing is deferred
    const out4 = await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    assert.strictEqual(exits().length, 3, 'never double-booked');
    assert.ok(!(out4.skipped || []).some((s) => /sweep deferred/.test(s.why || '')), 'no phantom deferral on the empty book');
    const st = JSON.parse(fs.readFileSync(process.env.TRADER_STATE_FILE, 'utf8'));
    assert.ok(!st.lastPos || !st.lastPos.SMH, 'the position is gone from lastPos');
  } finally {
    if (env.A == null) delete process.env.TRADER_AUTO_EXECUTE; else process.env.TRADER_AUTO_EXECUTE = env.A;
    if (env.M == null) delete process.env.TRADER_MANAGE_EXITS; else process.env.TRADER_MANAGE_EXITS = env.M;
  }
});

test('brain: a remembered basis is NOT used for a newer position this engine opened since', async () => {
  // The guard: the basis is only this position's basis while no newer entry was placed for the symbol.
  at._resetCooldowns();
  const now = Date.now();
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { QQQ: { qty: 24, entry: 753.11, mark: 752.0, ts: now - 2 * H } },
    entryAt: { QQQ: now - 2 * H },
    stopDistPct: { QQQ: 3 },
  }));
  at._loadState();
  const env = { A: process.env.TRADER_AUTO_EXECUTE, M: process.env.TRADER_MANAGE_EXITS };
  process.env.TRADER_AUTO_EXECUTE = '1'; process.env.TRADER_MANAGE_EXITS = '1';
  let positions = [], orders = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions,
    getIBKROpenOrders: async () => orders,
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    placeIBKROrder: async () => ({ status: 'error', reason: 'no broker writes in this test' }),
    cancelIBKROrder: async () => ({ status: 'error', reason: 'no broker writes in this test' }),
  };
  try {
    // the sweep records the basis (753.11) while QQQ is held, then the position leaves the book with a full fill
    positions = [{ symbol: 'QQQ', qty: 24, avg_entry_price: 753.11, current_price: 752.0 }]; orders = [];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    positions = []; orders = [{ orderId: 'q-full', symbol: 'QQQ', side: 'SELL', orderType: 'market', filledQty: 24, avgPrice: 751.3, status: 'filled', time: new Date().toISOString() }];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    const first = readRows().filter((r) => r.event === 'exit' && r.symbol === 'QQQ');
    assert.strictEqual(first.length, 1); assert.strictEqual(first[0].entry, 753.11, 'a full fill of a held position prices normally');
    // a NEWER engine entry for QQQ (the hold clock restarts), then its fill arrives before any sweep saw the new lot
    at._entryAtSet('QQQ', Date.now());
    orders = [orders[0], { orderId: 'q-new', symbol: 'QQQ', side: 'SELL', orderType: 'market', filledQty: 10, avgPrice: 750.0, status: 'filled', time: new Date(Date.now() + 1000).toISOString() }];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    const rows = readRows().filter((r) => r.event === 'exit' && r.symbol === 'QQQ');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].entry, null, 'the stale basis is not borrowed for a newer position: null, not a wrong number');
  } finally {
    at._resetCooldowns();   // clears the hold clock set above
    if (env.A == null) delete process.env.TRADER_AUTO_EXECUTE; else process.env.TRADER_AUTO_EXECUTE = env.A;
    if (env.M == null) delete process.env.TRADER_MANAGE_EXITS; else process.env.TRADER_MANAGE_EXITS = env.M;
  }
});
