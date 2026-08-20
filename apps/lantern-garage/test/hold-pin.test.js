'use strict';

/**
 * hold-pin.test.js — "keep GLD" is now expressible (#3318).
 *
 * 2026-08-14: the operator trimmed the carry to GLD-only and the engine
 * signal-exited GLD nine minutes into the session. A pinned symbol keeps every
 * protective mechanism (stop, ladder, breaker) but signal-derived exits are
 * suppressed with an honest skip row. Pins come from TRADER_PIN env and a
 * hot-reloaded pins.json (2s cache) — mid-session pinning, no restart.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
process.env.TRADER_PIN_FILE = path.join(dir, 'pins.json');
process.env.CONVERGENCE_RECORDS_FILE = path.join(dir, 'records.jsonl');
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
process.env.TRADER_ZONE_EXIT = '0';           // ladder ownership off so the raw signal_exit path is testable
process.env.TRADER_EXIT_MIN_PWIN = '0';
delete process.env.TRADER_PIN;

const { runAutoTrade, _resetCooldowns } = require('../lib/auto-trader');

let book = [];
let sells = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 900000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ ok: true }),
  placeIBKROrder: async (o) => { if (/sell/i.test(o.side)) sells.push(o.ticker); return { status: 'placed', order_id: 'P1' }; },
};

const GLD = { symbol: 'GLD', qty: 290, avg_entry_price: 399.78, current_price: 402, market_value: 116580, unrealized_pl: 644 };
const bear = () => ({ symbol: 'GLD', direction: 'BEARISH', entry_price: 402,
  convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 },   // bearish + ENTER = 'enter the exit' (verdict shape)
  plan: { stop: 390, target1: 410, target2: 416, hold_days: 1 }, volume_ratio: 1, atr: 1.5, zones: [] });

const scan = () => runAutoTrade({ signals: [bear()], spy_1d: 0 }, { bridge, userId: 't', now: Date.now() });
const skipWhy = (out) => ((out.skipped || []).find((x) => x.symbol === 'GLD') || {}).why || '';

test('unpinned baseline: the bearish read sells GLD (the 2026-08-14 behavior)', async () => {
  _resetCooldowns(); book = [GLD]; sells = [];
  const out = await scan();
  assert.ok((out.executed||[]).some(x=>x.symbol==='GLD'&&x.action==='exit_long'), `exit_long expected, skipped: ${skipWhy(out)}`);
});

test('TRADER_PIN=GLD suppresses the signal exit with an honest skip row', async () => {
  process.env.TRADER_PIN = 'GLD';
  try {
    _resetCooldowns(); book = [GLD]; sells = [];
    await new Promise((r) => setTimeout(r, 2100));   // pin cache window
    const out = await scan();
    assert.ok(!(out.executed||[]).some(x=>x.symbol==='GLD'), 'no exit for a pinned symbol');
    assert.match(skipWhy(out), /pinned/, 'the suppression is narrated, never silent');
    assert.match(skipWhy(out), /stop\/ladder still protect/);
  } finally { delete process.env.TRADER_PIN; }
});

test('pins.json works MID-SESSION — no restart, no env', async () => {
  _resetCooldowns(); book = [GLD]; sells = [];
  fs.writeFileSync(process.env.TRADER_PIN_FILE, JSON.stringify({ pins: ['gld'] }));   // case-insensitive
  await new Promise((r) => setTimeout(r, 2100));
  const out = await scan();
  assert.ok(!(out.executed||[]).some(x=>x.symbol==='GLD'));
  assert.match(skipWhy(out), /pinned/);
});

test('unpinning resumes exits — the pin is a hold, not a coffin', async () => {
  fs.unlinkSync(process.env.TRADER_PIN_FILE);
  await new Promise((r) => setTimeout(r, 2100));
  _resetCooldowns(); book = [GLD]; sells = [];
  const out=await scan();
  assert.ok((out.executed||[]).some(x=>x.symbol==='GLD'&&x.action==='exit_long'), 'with the pin gone, the signal exit fires again');
});
