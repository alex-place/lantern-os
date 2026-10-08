'use strict';
// carry-downday.test.js — the carry-on-a-down-day gate: the 15:50 de-carry stands aside for an inverse wrapper when
// SPY's session is at or below TRADER_CARRY_DOWNDAY_SPY_PCT; long wrappers, milder days, an empty feed and an unset
// knob all de-carry as before. Run against any tree: APP=<apps/lantern-garage> node --test carry-downday.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = process.env.APP || path.join(__dirname, '..');   // the tree under test (this one by default)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-downday-'));
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
delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT;
delete process.env.TRADER_CARRY_DOWNDAY_SYMBOLS;

// the market-data feed, stubbed the way the replay harness stubs it: SPY's 5m session bars drift from 100 to `last`
let spyLast = 100, spyBars = true;
const sessionBars = () => {
  if (!spyBars) return [];
  const out = []; const t0 = Date.parse('2026-08-17T13:30:00Z');   // 09:30 ET (EDT), a Monday
  for (let i = 0; i < 78; i++) { const c = 100 + (spyLast - 100) * (i / 77); out.push({ timestamp: new Date(t0 + i * 300000).toISOString(), open: c, high: c, low: c, close: c, volume: 0 }); }
  return out;
};
const stub = {
  getBarsMulti: async (tickers) => ({ bars: Object.fromEntries((tickers || []).map((t) => [String(t).toUpperCase(), { bars: String(t).toUpperCase() === 'SPY' ? sessionBars() : [] }])) }),
  getBars: async () => ({ bars: [], count: 0 }),
  getQuotes: async (tickers) => (tickers || []).map((t) => ({ symbol: t, price: 0 })),
  getSessionBars15m: async () => [],
};
const mdPath = require.resolve(path.join(APP, 'lib', 'market-data-yahoo.js'));
require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };

const { runAutoTrade, _resetCooldowns } = require(path.join(APP, 'lib', 'auto-trader'));

let book = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 500000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ ok: true }),
  placeIBKROrder: async () => ({ status: 'placed', order_id: 'D1' }),
};
const pos = (symbol, qty, px) => ({ symbol, qty, avg_entry_price: px, current_price: px, market_value: qty * px, unrealized_pl: 0 });
const AT_1555 = Date.parse('2026-08-17T19:55:00Z');   // 15:55 ET, inside the de-carry window
const scan = (now) => runAutoTrade({ signals: [], spy_1d: 0 }, { bridge, userId: 't', now });
const exited = (out, sym) => (out.executed || []).some((x) => x.symbol === sym && x.action === 'exit_long' && /eod_decarry/.test(x.reason || ''));
const skip = (out, sym) => ((out.skipped || []).find((x) => x.symbol === sym) || {}).why || '';

test('gate -1.5, SPY -2.0% on the session: the inverse wrapper is NOT de-carried, and the skip narrates', async () => {
  process.env.TRADER_CARRY_DOWNDAY_SPY_PCT = '-1.5'; spyLast = 98; spyBars = true;
  try {
    _resetCooldowns(); book = [pos('SOXS', 300, 40)];
    const out = await scan(AT_1555 + 1);
    assert.ok(!exited(out, 'SOXS'), 'the breakdown rides the gap');
    assert.match(skip(out, 'SOXS'), /carry_downday/, 'the suppression is narrated');
    assert.match(skip(out, 'SOXS'), /-2\.00%/, 'with SPY\'s session move');
  } finally { delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT; }
});

test('gate -1.5, SPY -0.5%: a milder day de-carries as before', async () => {
  process.env.TRADER_CARRY_DOWNDAY_SPY_PCT = '-1.5'; spyLast = 99.5; spyBars = true;
  try {
    _resetCooldowns(); book = [pos('SOXS', 300, 40)];
    const out = await scan(AT_1555 + 2);
    assert.ok(exited(out, 'SOXS'), 'flat into the close');
    assert.doesNotMatch(skip(out, 'SOXS'), /carry_downday/);
  } finally { delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT; }
});

test('gate -1.5, SPY -2.0%: a LONG wrapper (SOXL, in the default de-carry list) is still de-carried', async () => {
  process.env.TRADER_CARRY_DOWNDAY_SPY_PCT = '-1.5'; spyLast = 98; spyBars = true;
  try {
    _resetCooldowns(); book = [pos('SOXL', 200, 145)];
    const out = await scan(AT_1555 + 3);
    assert.ok(exited(out, 'SOXL'));
  } finally { delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT; }
});

test('knob unset: SPY -2.0% changes nothing, the inverse wrapper is de-carried', async () => {
  spyLast = 98; spyBars = true;
  _resetCooldowns(); book = [pos('SOXS', 300, 40)];
  const out = await scan(AT_1555 + 4);
  assert.ok(exited(out, 'SOXS'));
});

test('gate -1.5 with an empty SPY feed: fail-safe, the de-carry runs', async () => {
  process.env.TRADER_CARRY_DOWNDAY_SPY_PCT = '-1.5'; spyBars = false;
  try {
    _resetCooldowns(); book = [pos('SOXS', 300, 40)];
    const out = await scan(AT_1555 + 5);
    assert.ok(exited(out, 'SOXS'), 'no reading, no carry');
  } finally { delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT; spyBars = true; }
});

test('the carry set is configurable: SOXS outside TRADER_CARRY_DOWNDAY_SYMBOLS is de-carried on a -2% day', async () => {
  process.env.TRADER_CARRY_DOWNDAY_SPY_PCT = '-1.5'; process.env.TRADER_CARRY_DOWNDAY_SYMBOLS = 'SQQQ,SPXS'; spyLast = 98; spyBars = true;
  try {
    _resetCooldowns(); book = [pos('SOXS', 300, 40)];
    const out = await scan(AT_1555 + 6);
    assert.ok(exited(out, 'SOXS'));
  } finally { delete process.env.TRADER_CARRY_DOWNDAY_SPY_PCT; delete process.env.TRADER_CARRY_DOWNDAY_SYMBOLS; }
});
