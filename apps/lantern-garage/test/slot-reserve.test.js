'use strict';

/**
 * slot-reserve.test.js — the last slot belongs to conviction (#3317).
 *
 * 2026-08-14: five slots held largely by sub-0.50 probes when SMH fired at
 * 0.61 and was refused ("concurrent cap: 5 positions open") — it ran +0.82% to
 * the close. Week of 8/11: sub-0.50 entries netted −$516 (n=11) while ≥0.50
 * made money; 21 cap-blocks in 4 sessions.
 *
 * Rule: with TRADER_SLOT_RESERVE=R (default 1), a signal below
 * TRADER_SLOT_RESERVE_PWIN (default 0.55) may fill only up to cap−R slots;
 * conviction signals may use them all. Not lab-gateable (no p_win on daily
 * bars) — every refusal logs an audit row so live data accumulates the
 * counterfactual instead.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slotres-'));
process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
process.env.CONVERGENCE_RECORDS_FILE = path.join(dir, 'records.jsonl');
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
process.env.TRADER_POSITION_PCT = '12';
process.env.TRADER_MAX_POSITION_PCT = '12';
process.env.TRADER_RISK_PCT = '0.36';
process.env.TRADER_MIN_ENTRY_RR = '0';
process.env.TRADER_SUP_ENTRY = '0';   // SMH is on the sup-entry allowlist; zone geometry is not this test's subject
process.env.TRADER_MAX_CONCURRENT = '5';
delete process.env.TRADER_SLOT_RESERVE;        // default 1
delete process.env.TRADER_SLOT_RESERVE_PWIN;   // default 0.55

const { runAutoTrade, _resetCooldowns } = require('../lib/auto-trader');

let book = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 900000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  getIBKROpenOrders: async () => book.map((p) => ({ symbol: p.symbol, side: 'SELL', orderType: 'Stop', qty: Math.floor(Math.abs(p.qty)), status: 'PreSubmitted' })),
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ ok: true }),
  placeIBKROrder: async () => ({ status: 'placed', order_id: 'S1' }),
};

// four $50k sector holdings — real slots (above dust), no family conflict with SMH
const HELD4 = ['XLF', 'XLE', 'XLV', 'XLI'].map((s) => ({
  symbol: s, qty: 1000, avg_entry_price: 50, current_price: 50, market_value: 50000, unrealized_pl: 0,
}));

const sig = (p_win) => ({
  symbol: 'SMH', direction: 'BULLISH', entry_price: 583,
  convergence: { decision: 'ENTER', p_win, size_mult: 1 },
  plan: { stop: 565.5, target1: 618, target2: 640, hold_days: 1 },
  volume_ratio: 1.2, atr: 2.2, zones: [],
});

const scan = (signals) => runAutoTrade({ signals, spy_1d: 0 }, { bridge, userId: 't', now: Date.now() });
const verdict = (out) => {
  if ((out.executed || []).some((x) => x.symbol === 'SMH')) return 'entered';
  const sk = (out.skipped || []).find((x) => x.symbol === 'SMH');
  return sk ? sk.why : 'absent';
};

test('the Friday shape: 4 held, sub-threshold signal is refused with an AUDIT row', async () => {
  _resetCooldowns(); book = HELD4.slice();
  const why = verdict(await scan([sig(0.488)]));
  assert.match(why, /slot reserve/, `got: ${why}`);
  assert.match(why, /0\.488/, 'the refusal carries the signal\'s own p_win for the counterfactual ledger');
});

test('the same slot opens for conviction: 4 held, p_win 0.61 enters', async () => {
  _resetCooldowns(); book = HELD4.slice();
  assert.strictEqual(verdict(await scan([sig(0.61)])), 'entered');
});

test('the reserve never exceeds the cap: 5 held blocks even 0.61', async () => {
  _resetCooldowns();
  book = HELD4.concat([{ symbol: 'XLY', qty: 1000, avg_entry_price: 50, current_price: 50, market_value: 50000, unrealized_pl: 0 }]);
  assert.match(verdict(await scan([sig(0.61)])), /concurrent cap/);
});

test('below the contended zone nothing changes: 3 held, 0.488 enters', async () => {
  _resetCooldowns(); book = HELD4.slice(0, 3);
  assert.strictEqual(verdict(await scan([sig(0.488)])), 'entered');
});

test('boundary is inclusive: exactly 0.55 counts as conviction', async () => {
  _resetCooldowns(); book = HELD4.slice();
  assert.strictEqual(verdict(await scan([sig(0.55)])), 'entered');
});

test('TRADER_SLOT_RESERVE=0 restores first-come-first-served exactly', async () => {
  process.env.TRADER_SLOT_RESERVE = '0';
  try {
    _resetCooldowns(); book = HELD4.slice();
    assert.strictEqual(verdict(await scan([sig(0.488)])), 'entered');
  } finally {
    delete process.env.TRADER_SLOT_RESERVE;
  }
});
