'use strict';

/**
 * ladder-vol-targets.test.js — every entry gets a ladder that OWNS its exit.
 *
 * What failed live (2026-08-14): the ladder armed only for a 9-symbol fossil
 * allowlist AND only when a resistance zone sat above entry. SOXL — outside the
 * list, blue sky — got no ladder, so the first weak scan's signal_exit owned
 * the exit: entered 0.08% off the session low, bounce +3.83%, scratched at
 * +$72 of a $1,036 move.
 *
 * What the lab then falsified: "make R1 reachable" by tightening rungs to
 * k × daily-ATR. Swept 2000→2026, 10 symbols, 37,518 trades, fit/holdout —
 * every tightened variant loses BOTH windows on total income, monotonically.
 * Nearer full-exit targets amputate the winners' tail.
 *
 * The contract shipped:
 *   - EVERY placed entry arms a ladder (allowlist default 'all')
 *   - zone above → zone rungs (#3165 unchanged)
 *   - blue sky → rungs at the PLAN targets (the lab-validated distances)
 *   - an armed ladder owns the exit after min-hold — signal_exit pre-empted
 *   - TRADER_LADDER_VOL_MULT>0 = the falsified tightening, opt-in only, default off
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
process.env.CONVERGENCE_RECORDS_FILE = path.join(dir, 'records.jsonl');
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';
delete process.env.TRADER_ZONE_EXIT_SYMBOLS;     // default: all
delete process.env.TRADER_LADDER_VOL_MULT;       // default: OFF (falsified)
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';     // veto reads LIVE bars over the network — not this test's subject
// production sizing + gates, so entries actually place
process.env.TRADER_POSITION_PCT = '12';
process.env.TRADER_MAX_POSITION_PCT = '12';
process.env.TRADER_RISK_PCT = '0.36';
process.env.TRADER_MIN_ENTRY_RR = '0';   // production config (operator 2026-08-10: the RR gate cost ~80% of income)

const { runAutoTrade, _resetCooldowns, _saveState, STATE_FILE } = require('../lib/auto-trader');

let book = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 900000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  // held positions carry protective stops — an empty orders read next to a held
  // position trips the orders-fetch hardening and stands the whole scan down
  getIBKROpenOrders: async () => book.map((p) => ({ symbol: p.symbol, side: 'SELL', orderType: 'Stop', qty: Math.floor(Math.abs(p.qty)), status: 'PreSubmitted' })),
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ ok: true }),
  placeIBKROrder: async () => ({ status: 'placed', order_id: 'L1' }),
};

const sig = (over = {}) => ({
  symbol: 'SOXL', direction: 'BULLISH', entry_price: 140,
  convergence: { decision: 'ENTER', p_win: 0.62, size_mult: 1 },
  plan: { stop: 135.8, target1: 148.4, target2: 154, hold_days: 1 },
  volume_ratio: 1.2, atr: 0.55, zones: [],
  ...over,
});

const ladderOf = (sym) => (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).zoneLadder || {})[sym];
const scan = (signals, now) => runAutoTrade({ signals, spy_1d: 0 }, { bridge, userId: 't', now: now || Date.now() });

test('blue sky arms at the PLAN targets — symbol outside the old allowlist, no zone needed', async () => {
  _resetCooldowns(); book = [];
  await scan([sig()]);
  _saveState();
  const lad = ladderOf('SOXL');
  assert.ok(lad, 'SOXL (never in the 9-symbol fossil list) must arm a ladder');
  assert.strictEqual(lad.r1, 148.4, 'r1 = plan.target1 — the lab-validated distance, not a tightened one');
  assert.strictEqual(lad.r2, 154, 'r2 = plan.target2');
  assert.ok(lad.r2 > lad.r1, 'rungs ascend');
});

test('an armed ladder OWNS the exit after min-hold — the SOXL scratch path is closed', async () => {
  book = [{ symbol: 'SOXL', qty: 208, avg_entry_price: 140, current_price: 140.7, market_value: 29265, unrealized_pl: 145 }];
  // runAutoTrade early-returns 'no ENTER signals' before the exit loop on a
  // pure-exit scan — ride along a harmless ENTER that dies at 'size < 1 share'.
  // 21 minutes later: past min-hold, so ownership — not the hold timer — answers.
  const out = await scan([
    sig({ direction: 'BEARISH', convergence: { decision: 'ENTER', p_win: 0.85 } }),   // the live enter-short verdict the longs-only engine routes to the EXIT path
    { symbol: 'QQQ', direction: 'BULLISH', entry_price: 0, convergence: { decision: 'ENTER', p_win: 0.6, size_mult: 1 }, plan: {}, zones: [] },
  ], Date.now() + 21 * 60 * 1000);
  const skip = (out.skipped || []).find((x) => x.symbol === 'SOXL');
  assert.ok(skip && /zone ladder owns/.test(skip.why), `signal_exit must be pre-empted, got: ${skip && skip.why}`);
});

test('a qualifying zone above entry still provides the rungs (#3165 unchanged)', async () => {
  _resetCooldowns(); book = [];
  // 142.5 clears tgtMinR (0.6R at the 3% stop) → zone-first, plan targets unused
  await scan([sig({ zones: [{ type: 'RESISTANCE', level: 142.5, top: 142.8 }] })]);
  _saveState();
  const lad = ladderOf('SOXL');
  assert.ok(Math.abs(lad.r1 - 142.5) < 0.01, `zone is r1, got ${lad.r1}`);
  assert.ok(Math.abs(lad.r1top - 142.8) < 0.01, 'zone top carried');
  assert.ok(lad.r2 > lad.r1, 'fallback r2 ascends above the zone r1');
});

test('a plan with no usable targets still arms — 3%/5.1% defaults, never a dead ladder', async () => {
  _resetCooldowns(); book = [];
  await scan([sig({ symbol: 'XLU', entry_price: 44, atr: 0, plan: { stop: 42.7, hold_days: 1 } })]);
  _saveState();
  const lad = ladderOf('XLU');
  assert.ok(lad, 'armed even with a bare plan');
  assert.ok(Math.abs(lad.r1 - 44 * 1.03) < 0.01, `default r1 at +3%, got ${lad.r1}`);
  assert.ok(Math.abs(lad.r2 - 44 * 1.051) < 0.01, `default r2 at +5.1%, got ${lad.r2}`);
});

test('TRADER_LADDER_VOL_MULT>0 opts into the falsified tightened mode (kept for runner re-tests)', async () => {
  process.env.TRADER_LADDER_VOL_MULT = '0.75';
  try {
    _resetCooldowns(); book = [];
    await scan([sig()]);   // atr 0.55 → dayVol ≈ 2.0% → r1 ≈ 140 × 1.015 ≈ 142.10
    _saveState();
    const lad = ladderOf('SOXL');
    assert.ok(lad.r1 > 141.9 && lad.r1 < 142.3, `vol rung when explicitly opted in, got ${lad.r1}`);
  } finally {
    delete process.env.TRADER_LADDER_VOL_MULT;
  }
});

test('restricted allowlist mode still works when configured explicitly', async () => {
  process.env.TRADER_ZONE_EXIT_SYMBOLS = 'SPY,QQQ';
  try {
    _resetCooldowns(); book = [];
    await scan([sig()]);
    _saveState();
    assert.strictEqual(ladderOf('SOXL'), undefined, 'SOXL excluded by the explicit list');
  } finally {
    delete process.env.TRADER_ZONE_EXIT_SYMBOLS;
  }
});
