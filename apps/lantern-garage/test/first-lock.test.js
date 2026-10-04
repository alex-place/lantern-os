'use strict';
/**
 * first-lock.test.js — TRADER_FIRST_LOCK (2026-10-04): an early first lock under the stepped floor.
 *
 * The 1% stepped floor (step-floor.test.js) arms at +1%, a level tuned on a book that held 3x funds. On a 1x index
 * ETF many dip-buys go up 0.5%, come back and end as losers. TRADER_FIRST_LOCK="arm:lock" (percent) raises the stop
 * to entry + lock once the position is up `arm`, below the first whole step; the stepped floor takes over at its
 * first step and a lock never lowers. Pinned here, on the step-floor fixture:
 *   - "0.5:0.1" with 1% steps: +0.6% locks entry+0.1% and the ledger says first_lock; +0.3% does nothing;
 *     +1.2% is the stepped floor's entry+1% as before;
 *   - the lock only rises: after the first lock a lower mark changes nothing, and +1.2% steps it up to entry+1%;
 *   - unset: +0.6% does nothing (the floor as it was);
 *   - TRADER_FIRST_LOCK_SYMBOLS scopes it: a symbol outside the list is untouched;
 *   - a malformed value (lock >= arm, junk) is off;
 *   - flat mode (no stepped floor) ignores it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'firstlock-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
// HERMETIC EXITS — the fixture holds LNG, a real ticker: pin the exit-authority switches (see step-floor.test.js).
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const resizes = () => rows().filter((r) => r.event === 'stop_resize');

/** A held long at entry 100 marked at `mark`, with a resting stop at `stopPx`. `keep` leaves the ratchet registry as it is. */
function world({ mark, stopPx = 97, keep = false }) {
  if (!keep) at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  if (!keep) { fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark, ts: Date.now() } } })); at._loadState(); }
  const placed = [], cancelled = [];
  return {
    placed, cancelled,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: mark, market_value: 100 * mark, unrealized_pl: (mark - 100) * 100 }],
    getIBKROpenOrders: async () => [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: stopPx, qty: 100 }],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => { cancelled.push(id); return { status: 'cancelled' }; },
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
}
const scan = { signals: [] };
const armed = () => { process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_STEP_FLOOR = '1'; };
const clear = () => { for (const k of ['TRADER_BE_RATCHET', 'TRADER_BE_LOCK', 'TRADER_STEP_FLOOR', 'TRADER_FIRST_LOCK', 'TRADER_FIRST_LOCK_SYMBOLS']) delete process.env[k]; };

test('the config read: "arm:lock" in percent; junk, lock >= arm and an out-of-scope symbol are off', () => {
  try {
    process.env.TRADER_FIRST_LOCK = '0.5:0.1';
    assert.deepStrictEqual(at._firstLockCfg('SPY'), { arm: 0.5, lock: 0.1 });
    process.env.TRADER_FIRST_LOCK_SYMBOLS = 'SPY, qqq';
    assert.deepStrictEqual(at._firstLockCfg('QQQ'), { arm: 0.5, lock: 0.1 });
    assert.strictEqual(at._firstLockCfg('SOXL'), null, 'outside the scope list');
    delete process.env.TRADER_FIRST_LOCK_SYMBOLS;
    for (const bad of ['0.5:0.5', '0.5:0.9', 'x:y', '0.5', '', '0:0']) { process.env.TRADER_FIRST_LOCK = bad; assert.strictEqual(at._firstLockCfg('SPY'), null, `"${bad}" is off`); }
  } finally { clear(); }
});

test('"0.5:0.1" under 1% steps: +0.6% locks entry+0.1% and the ledger says first_lock', async () => {
  armed(); process.env.TRADER_FIRST_LOCK = '0.5:0.1';
  try {
    const w = world({ mark: 100.6 });
    await at.runAutoTrade(scan, { bridge: w, userId: 't' });
    const r = resizes();
    assert.strictEqual(r.length, 1, 'one resize');
    assert.strictEqual(r[0].stop_want, 100.1, 'stop to entry+0.1%');
    assert.ok(/^first_lock/.test(r[0].reason), r[0].reason);
    assert.strictEqual(r[0].first_lock, true);
    assert.deepStrictEqual(w.cancelled, ['S1'], 'the 3% stop is cancelled for the re-protect pass');
  } finally { clear(); }
});

test('+0.3% is below the arm: nothing; +1.2% is the stepped floor s entry+1%, as before', async () => {
  armed(); process.env.TRADER_FIRST_LOCK = '0.5:0.1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.3 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, '+0.3% < the 0.5% arm');
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.2 }), userId: 't' });
    const r = resizes();
    assert.strictEqual(r[0].stop_want, 101); assert.ok(/^step_floor/.test(r[0].reason), r[0].reason); assert.strictEqual(r[0].first_lock, undefined);
  } finally { clear(); }
});

test('the lock only rises: a lower mark after the first lock changes nothing; +1.2% steps it up to entry+1%', async () => {
  armed(); process.env.TRADER_FIRST_LOCK = '0.5:0.1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 100.1);
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.2, stopPx: 100.1, keep: true }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'back to +0.2%: the 100.1 lock stands');
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.7, stopPx: 100.1, keep: true }), userId: 't' });
    assert.strictEqual(resizes().length, 0, '+0.7% again: still the first lock, not re-issued');
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.2, stopPx: 100.1, keep: true }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 101, 'the stepped floor takes over at +1%');
  } finally { clear(); }
});

test('unset: +0.6% does nothing (the floor as it was); a scoped list leaves other symbols alone', async () => {
  armed();
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'no first lock without the knob');
    process.env.TRADER_FIRST_LOCK = '0.5:0.1'; process.env.TRADER_FIRST_LOCK_SYMBOLS = 'SPY,QQQ';
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'LNG is outside the scope list');
  } finally { clear(); }
});

test('flat mode (no stepped floor) ignores it: the one-shot +1% ratchet is unchanged', async () => {
  process.env.TRADER_BE_RATCHET = '0.01'; process.env.TRADER_BE_LOCK = '0.01'; process.env.TRADER_FIRST_LOCK = '0.5:0.1';
  try {
    await at.runAutoTrade(scan, { bridge: world({ mark: 100.6 }), userId: 't' });
    assert.strictEqual(resizes().length, 0, 'flat mode: nothing below the +1% trigger');
    await at.runAutoTrade(scan, { bridge: world({ mark: 101.4 }), userId: 't' });
    assert.strictEqual(resizes()[0].stop_want, 101); assert.ok(/^be_ratchet/.test(resizes()[0].reason));
  } finally { clear(); }
});
