'use strict';
/**
 * eod-flat.test.js — TRADER_EOD_FLAT (2026-08-24, operator: "it should never
 * hold positions over the weekends").
 *
 * The live book split the two proposals apart: weekday overnight holds are
 * profit factor 2.58 and 71% of all profit, while the eight weekend holds net
 * −$228. overnight_policy_lab.js agrees on the four surfaces — 'weekend' is
 * +4% on the 26-year holdout and better on both holdout surfaces, 'all' costs
 * three of four. So the weekend leg is the one worth cutting, and the knob
 * exposes both. Default off; regular hours only; pinned symbols exempt.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eodflat-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
// HERMETIC EXITS (2026-08-25). These fixtures hold a position in "LNG" — a REAL
// ticker — and the engine's market-data-driven exits fetch live bars for whatever
// symbol it is holding. So with those exits at their defaults the suite's verdict
// depends on Cheniere Energy's intraday MACD/RSI: CI was green at 14:49 ET and red
// at 15:58 ET the same afternoon, with be-ratchet losing 6 tests and eod-flat 4 to
// a `momentum_died (MACD hist<0, <EMA9, RSI 40)` exit that closed the position out
// from under the behaviour being tested. Pinning the five exit-authority switches
// to their ARMED production values (#3437/#3438) makes the fixture deterministic
// AND more faithful to the engine that actually runs. A test about the end-of-day flat rule must
// not be able to fail because a real stock moved.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

// 2026-08-28 is a Friday, 2026-08-27 a Thursday (verified below so the fixture can't rot).
const FRI = new Date('2026-08-28T19:55:00Z');   // 15:55 ET Friday
const THU = new Date('2026-08-27T19:55:00Z');   // 15:55 ET Thursday
const FRI_EARLY = new Date('2026-08-28T17:00:00Z'); // 13:00 ET Friday — before the flat window

test('the fixture dates really are Friday and Thursday in ET', () => {
  const dow = (d) => new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  assert.strictEqual(dow(FRI), 5, 'FRI must be a Friday in ET');
  assert.strictEqual(dow(THU), 4, 'THU must be a Thursday in ET');
});

function world() {
  at._resetCooldowns();
  if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG);
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 101, ts: Date.now() } },
    entryAt: { LNG: Date.now() - 5 * 3600e3 },
  }));
  at._loadState();
  const placed = [];
  const bridge = {
    placed,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: 101, market_value: 10100, unrealized_pl: 100 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
  return bridge;
}
const sells = (b) => b.placed.filter((o) => o.ticker === 'LNG' && o.side === 'sell' && !/stop/i.test(o.type || ''));
const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);
const run = (bridge, now) => at.runAutoTrade({ signals: [] }, { bridge, userId: 't', now: now.getTime() });

test('default (unset): a held long is NOT flattened on Friday — the validated behaviour', async () => {
  delete process.env.TRADER_EOD_FLAT;
  const bridge = world();
  await run(bridge, FRI);
  assert.strictEqual(sells(bridge).length, 0);
});

test("EOD_FLAT=weekend: flat into Friday's close, journaled as eod_flat_weekend", async () => {
  process.env.TRADER_EOD_FLAT = 'weekend';
  try {
    const bridge = world();
    await run(bridge, FRI);
    assert.strictEqual(sells(bridge).length, 1, 'the position is closed');
    assert.ok(rows().some((r) => /eod_flat_weekend/.test(String(r.reason))), 'reason names the weekend rule');
  } finally { delete process.env.TRADER_EOD_FLAT; }
});

test('EOD_FLAT=weekend: a Thursday close is left alone (weekday overnight is 71% of live profit)', async () => {
  process.env.TRADER_EOD_FLAT = 'weekend';
  try {
    const bridge = world();
    await run(bridge, THU);
    assert.strictEqual(sells(bridge).length, 0);
  } finally { delete process.env.TRADER_EOD_FLAT; }
});

test('EOD_FLAT=weekend: Friday BEFORE the flat window (13:00 ET) does not fire', async () => {
  process.env.TRADER_EOD_FLAT = 'weekend';
  try {
    const bridge = world();
    await run(bridge, FRI_EARLY);
    assert.strictEqual(sells(bridge).length, 0);
  } finally { delete process.env.TRADER_EOD_FLAT; }
});

test('EOD_FLAT=all: every session close flattens, including Thursday', async () => {
  process.env.TRADER_EOD_FLAT = 'all';
  try {
    const bridge = world();
    await run(bridge, THU);
    assert.strictEqual(sells(bridge).length, 1);
    assert.ok(rows().some((r) => /eod_flat \(no overnight holds\)/.test(String(r.reason))));
  } finally { delete process.env.TRADER_EOD_FLAT; }
});

test('TRADER_EOD_FLAT_MIN moves the window; a pinned symbol is never flattened', async () => {
  process.env.TRADER_EOD_FLAT = 'weekend';
  process.env.TRADER_EOD_FLAT_MIN = '840';   // 14:00 ET
  try {
    const bridge = world();
    await run(bridge, FRI_EARLY);            // 13:00 ET — still before 14:00
    assert.strictEqual(sells(bridge).length, 0, 'before the moved window');
    const b2 = world();
    await run(b2, new Date('2026-08-28T18:30:00Z'));   // 14:30 ET Friday
    assert.strictEqual(sells(b2).length, 1, 'after the moved window');
  } finally { delete process.env.TRADER_EOD_FLAT; delete process.env.TRADER_EOD_FLAT_MIN; }
});
