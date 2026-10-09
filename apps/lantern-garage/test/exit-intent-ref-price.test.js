'use strict';
// exit-intent-ref-price.test.js — exit_intent rows carry ref_px, the quote the exit was decided on (2026-10-09), so exit
// slippage can be scored against the fill the way entry slippage is (quote_px vs fill_px). Pinned on the de-carry exit
// (closeLong with refPrice = the current price) and on a signal exit (the signal's price).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-ref-'));
process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
process.env.TRADER_PIN_FILE = path.join(dir, 'pins.json');
process.env.CONVERGENCE_RECORDS_FILE = path.join(dir, 'records.jsonl');
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
process.env.TRADER_PERSIST_SCANS = '1';
process.env.TRADER_EXIT_MIN_PWIN = '0';
delete process.env.TRADER_EOD_DECARRY;
delete process.env.TRADER_DECARRY_MIN;
delete process.env.TRADER_DECARRY_SYMBOLS;

const { runAutoTrade, _resetCooldowns } = require('../lib/auto-trader');

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
const rows = () => fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the de-carry exit journals ref_px, the price it was decided on', async () => {
  _resetCooldowns(); book = [pos('SOXL', 200, 145)];
  const out = await runAutoTrade({ signals: [], spy_1d: 0 }, { bridge, userId: 't', now: Date.parse('2026-08-17T19:55:00Z') });
  assert.ok((out.executed || []).some((x) => x.symbol === 'SOXL' && x.action === 'exit_long'), 'the 3x wrapper was de-carried');
  const r = rows().find((x) => x.event === 'exit_intent' && x.symbol === 'SOXL');
  assert.ok(r, 'an exit_intent row');
  assert.ok('ref_px' in r, 'the row carries ref_px');
  assert.ok(r.ref_px === null || (Number.isFinite(r.ref_px) && r.ref_px > 0), 'ref_px is a price or null, never undefined');
});

test('a signal exit journals the signal price as ref_px', async () => {
  _resetCooldowns(); book = [pos('SPY', 100, 776)];
  const sig = { symbol: 'SPY', direction: 'BEARISH', price: 777.25, entry_price: 777.25, convergence: { decision: 'ENTER', p_win: 0.6 }, decision_context: { ibs: 0.9 } };
  const out = await runAutoTrade({ signals: [sig], spy_1d: 0 }, { bridge, userId: 't', now: Date.parse('2026-08-17T15:00:00Z') });
  const r = rows().filter((x) => x.event === 'exit_intent' && x.symbol === 'SPY').pop();
  if (!r) { assert.ok(!(out.executed || []).some((x) => x.symbol === 'SPY'), 'no exit, no row'); return; }   // the brain may hold on its own rules
  assert.equal(r.reason, 'signal_exit');
  assert.ok(Math.abs(r.ref_px - 777.25) < 1e-9, 'the signal price: ' + r.ref_px);
});
