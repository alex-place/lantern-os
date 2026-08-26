'use strict';
/**
 * step-floor.test.js — TRADER_STEP_FLOOR (operator, 2026-08-24): "if it's at
 * 1%+ the exit should be 1%, if 2%+ it should be 2%, if 3%+ it should be 3%".
 *
 * The flat floor (#3415) ratcheted ONCE — on 2026-08-24 SOXL reached +4.13%
 * and its stop stayed at entry+1%, and the book captured 44% of the MFE it
 * reached. The stepped floor moves the stop up each time the mark crosses
 * another step and never lowers it. Measured on the four surfaces (step 1%:
 * h2 49.7% ÷8.88 vs 44.5% ÷7.57, 26y ÷161 vs ÷129) and — unlike the round-6
 * ratchet trail — it survives finer bars (5m +0.4% vs −0.9%).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stepfloor-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
// HERMETIC EXITS (2026-08-25). These fixtures hold a position in "LNG" — a REAL
// ticker — and the engine's market-data-driven exits fetch live bars for whatever
// symbol it is holding. So with those exits at their defaults the suite's verdict
// depends on Cheniere Energy's intraday MACD/RSI: CI was green at 14:49 ET and red
// at 15:58 ET the same afternoon, with be-ratchet losing 6 tests and eod-flat 4 to
// a `momentum_died (MACD hist<0, <EMA9, RSI 40)` exit that closed the position out
// from under the behaviour being tested. Pinning the five exit-authority switches
// to their ARMED production values (#3437/#3438) makes the fixture deterministic
// AND more faithful to the engine that actually runs. A test about the step floor must
// not be able to fail because a real stock moved.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resizes = () => rows().filter((r) => r.event === 'stop_resize');

/** A held long at entry 100 marked at `mark`, with a resting stop at `stopPx`. */
function world({ mark, stopPx = 97 }) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark, ts: Date.now() } } }));
  at._loadState();
  const placed = [], cancelled = [];
  const bridge = {
    placed, cancelled,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: mark, market_value: 100 * mark, unrealized_pl: (mark - 100) * 100 }],
    getIBKROpenOrders: async () => [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: stopPx, qty: 100 }],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => { cancelled.push(id); return { status: 'cancelled' }; },
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
  return bridge;
}
const scan = { signals: [] };

test('FLAT mode (unchanged): +1.4% ratchets once to entry+1%, and never again', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01';
  delete process.env.TRADER_STEP_FLOOR;
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.4 }), userId: 't' });
    const r = resizes();
    assert.strictEqual(r.length, 1, 'one resize');
    assert.strictEqual(r[0].stop_want, 101, 'stop to entry+1%');
    assert.ok(/be_ratchet/.test(r[0].reason), r[0].reason);
    // a later, much higher mark does NOT move it again in flat mode
    await at.runAutoTrade(scan, { bridge: world({ mark: 104.5, stopPx: 101 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'flat mode is one-shot for this symbol');
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; }
});

test('STEP 1%: +4.5% locks entry+4%, naming the step in the ledger', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 104.5 }), userId: 't' });
    const r = resizes();
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].stop_want, 104, '+4.5% -> lock 4%');
    assert.ok(/step_floor/.test(r[0].reason) && /1% steps/.test(r[0].reason), r[0].reason);
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});

test('STEP 1% climbs with the mark and NEVER lowers', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.2 }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 101, 'first step');
    await at.runAutoTrade(scan, { bridge: world({ mark: 103.3, stopPx: 101 }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 103, 'climbs to +3%');
    // mark falls back to +1.5%: the 103 lock stands, no new resize
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.5, stopPx: 103 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'never re-lowers');
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});

test('below the first step nothing happens; step 0.5% is finer-grained', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, '+0.6% is below the first 1% step');
    process.env.TRADER_STEP_FLOOR = '0.5';
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 100.5, 'half-percent steps lock +0.5%');
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});

test('the lock is clamped below the market so the broker cannot reject it', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1';
  try {
    // mark exactly on a step boundary: lock 103 would sit AT the market
    await at.runAutoTrade(scan, { bridge: world({ mark: 103.0 }), userId: 't' });
    const w = resizes()[0].stop_want;
    assert.ok(w < 103.0, `stop must sit below the mark (got ${w})`);
    assert.ok(w >= 102.8, `but only just below (got ${w})`);
  } finally { delete process.env.TRADER_BE_RATCHET; delete process.env.TRADER_BE_LOCK; delete process.env.TRADER_STEP_FLOOR; }
});
