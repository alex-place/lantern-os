'use strict';
// eod-decarry.test.js — leveraged holdings go flat into the close (#3298-3).
// Stops cannot protect through a gap; 3x carries 3x overnight exposure at equal
// notional (64% of the 8/13→14 give-back was the gap). The operator ran this
// policy by hand twice; now it is automatic from 15:50 ET, pin-overridable,
// killed by TRADER_EOD_DECARRY=0. 1x names are never touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decarry-'));
process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
process.env.TRADER_PIN_FILE = path.join(dir, 'pins.json');
process.env.CONVERGENCE_RECORDS_FILE = path.join(dir, 'records.jsonl');
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
delete process.env.TRADER_EOD_DECARRY;
delete process.env.TRADER_DECARRY_MIN;
delete process.env.TRADER_DECARRY_SYMBOLS;

const { runAutoTrade, _resetCooldowns } = require('../lib/auto-trader');

let book = [];
let sells = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 500000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ ok: true }),
  placeIBKROrder: async (o) => { if (/sell/i.test(o.side)) sells.push(o.ticker); return { status: 'placed', order_id: 'D1' }; },
};
const pos = (symbol, qty, px) => ({ symbol, qty, avg_entry_price: px, current_price: px, market_value: qty * px, unrealized_pl: 0 });
// 2026-08-17 is a Monday; 19:55Z = 15:55 ET (EDT), inside the de-carry window
const AT_1555 = Date.parse('2026-08-17T19:55:00Z');
const AT_1400 = Date.parse('2026-08-17T18:00:00Z');
const scan = (now) => runAutoTrade({ signals: [], spy_1d: 0 }, { bridge, userId: 't', now });
const exited = (out, sym) => (out.executed || []).some((x) => x.symbol === sym && x.action === 'exit_long' && /eod_decarry/.test(x.reason || ''));

test('15:55 ET: a held 3x (SOXL) is flattened with the eod_decarry reason', async () => {
  _resetCooldowns(); book = [pos('SOXL', 200, 145)]; sells = [];
  const out = await scan(AT_1555);
  assert.ok(exited(out, 'SOXL'), 'the leveraged carry must go flat into the close');
  const led = fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8');
  assert.match(led, /eod_decarry/, 'the ledger narrates why');
});

test('14:00 ET: untouched — the window starts at 15:50', async () => {
  _resetCooldowns(); book = [pos('SOXL', 200, 145)]; sells = [];
  const out = await scan(AT_1400);
  assert.ok(!exited(out, 'SOXL'));
});

test('1x names are never de-carried — SPY holds overnight freely', async () => {
  _resetCooldowns(); book = [pos('SPY', 100, 776)]; sells = [];
  const out = await scan(AT_1555);
  assert.ok(!exited(out, 'SPY'));
});

test('a PIN overrides: deliberate carry, narrated', async () => {
  process.env.TRADER_PIN = 'SOXL';
  try {
    _resetCooldowns(); book = [pos('SOXL', 200, 145)]; sells = [];
    await new Promise((r) => setTimeout(r, 2100));
    const out = await scan(AT_1555);
    assert.ok(!exited(out, 'SOXL'), 'pinned carry stands');
    const sk = (out.skipped || []).find((x) => x.symbol === 'SOXL');
    assert.match((sk && sk.why) || '', /eod_decarry suppressed/, 'the override is narrated');
  } finally { delete process.env.TRADER_PIN; }
});

test('TRADER_EOD_DECARRY=0 kills the rule', async () => {
  process.env.TRADER_EOD_DECARRY = '0';
  try {
    _resetCooldowns(); book = [pos('SOXL', 200, 145)]; sells = [];
    const out2 = await scan(AT_1555);
    assert.ok(!exited(out2, 'SOXL'));
  } finally { delete process.env.TRADER_EOD_DECARRY; }
});

test('dust is untouchable here too — 0.8 shares cannot fill an order', async () => {
  _resetCooldowns(); book = [pos('SOXS', 0.8, 40)]; sells = [];
  const out = await scan(AT_1555);
  assert.ok(!exited(out, 'SOXS'));
});
