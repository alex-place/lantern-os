'use strict';

/**
 * Trailing-stop ratchet + state persistence (auto-trader.js).
 *
 * Covers the SOXS "+35% peak → gave back $3k, never fired" regression:
 *   1. trailTriggerPct ratchets tighter as the peak gain grows.
 *   2. _saveState/_loadState round-trip the peak so a restart can't reset it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const at = require('../lib/auto-trader');

test('momentum-death timeframe defaults to 5m and is env-overridable', () => {
  const saved = process.env.TRADER_MOMENTUM_TF;
  try {
    delete process.env.TRADER_MOMENTUM_TF;
    assert.strictEqual(at.cfg().momentumTf, '5m');       // faster peak capture by default
    process.env.TRADER_MOMENTUM_TF = '15m';
    assert.strictEqual(at.cfg().momentumTf, '15m');       // operator can smooth it back
  } finally {
    if (saved === undefined) delete process.env.TRADER_MOMENTUM_TF; else process.env.TRADER_MOMENTUM_TF = saved;
  }
});

test('trailTriggerPct ratchets tighter as the peak gain grows', () => {
  const base = 2.5;
  assert.strictEqual(at.trailTriggerPct(1, base), 2.5);    // tiny gain → base (room to develop)
  assert.strictEqual(at.trailTriggerPct(5, base), 2.5);    // just under first tier
  assert.strictEqual(at.trailTriggerPct(6, base), 2.25);   // ≥6%  → 2.25
  assert.strictEqual(at.trailTriggerPct(12, base), 1.75);  // ≥12% → 1.75
  assert.strictEqual(at.trailTriggerPct(25, base), 1.25);  // ≥25% → 1.25
  assert.strictEqual(at.trailTriggerPct(35, base), 1.25);  // SOXS case → locked tight
});

test('trailTriggerPct never exceeds the base (a tighter base wins)', () => {
  // If the operator sets a very tight base, the ratchet must not loosen it.
  assert.strictEqual(at.trailTriggerPct(35, 1.0), 1.0);
  assert.strictEqual(at.trailTriggerPct(8, 2.0), 2.0);     // min(2.25, 2.0) = 2.0
});

test('SOXS scenario: +35% peak giving back 1.25% now fires (was 3% / broken)', () => {
  const entry = 42.65, peak = 57.69;
  const peakGainPct = ((peak - entry) / entry) * 100;      // ≈35.3%
  const trig = at.trailTriggerPct(peakGainPct, 2.5);       // → 1.25%
  const exitAt = peak * (1 - trig / 100);                  // ≈$56.97
  // The old flat 3% only fired at ~$55.96; the ratchet fires ~$1 higher, banking more.
  assert.ok(trig === 1.25);
  assert.ok(exitAt > 56.9 && exitAt < 57.0);
});

test('_saveState writes a valid snapshot to the real STATE_FILE; _loadState reads it back', () => {
  // Exercise the real helpers against the real path. _resetCooldowns() clears the
  // in-memory maps and saves, so after it the on-disk snapshot is a well-formed,
  // empty-but-shaped object — and _loadState() must consume it without throwing.
  assert.strictEqual(typeof at.STATE_FILE, 'string');
  assert.doesNotThrow(() => at._resetCooldowns());          // clears + _saveState()
  assert.ok(fs.existsSync(at.STATE_FILE), 'snapshot file written');
  const snap = JSON.parse(fs.readFileSync(at.STATE_FILE, 'utf8'));
  for (const k of ['peak', 'entryAt', 'exitAt', 'exitStatus', 'lastOrderAt', 'dirStreak']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, k), `snapshot has ${k}`);
  }
  assert.strictEqual(typeof snap.savedAt, 'number');
  assert.doesNotThrow(() => at._loadState());               // reload must be safe
});

test('isFallingKnife: true when momentum still cratering, false once it turns', () => {
  // Flat, then a sharp accelerating late drop → MACD histogram negative AND deepening → knife.
  const crater = [...Array.from({ length: 45 }, () => 100), ...Array.from({ length: 15 }, (_, i) => 100 - Math.pow(i + 1, 1.8) * 0.4)];
  assert.strictEqual(at.isFallingKnife(crater), true);
  // A downtrend that bottoms and turns up in the last bars → histogram rising → NOT a knife.
  const turn = [...Array.from({ length: 45 }, (_, i) => 100 - i * 1.2), ...Array.from({ length: 15 }, (_, i) => 46 + i * 1.4)];
  assert.strictEqual(at.isFallingKnife(turn), false);
  // A steady uptrend is never a knife.
  const up = Array.from({ length: 60 }, (_, i) => 50 + i * 0.8);
  assert.strictEqual(at.isFallingKnife(up), false);
});

test('isFallingKnife: fail-open on insufficient data (does not block entries)', () => {
  assert.strictEqual(at.isFallingKnife([]), false);
  assert.strictEqual(at.isFallingKnife(Array.from({ length: 20 }, () => 10)), false);
});

test('re-exit churn: an UNCONFIRMED exit fires once and does not re-fire while the position stays held (even after the reattempt timer expires)', async () => {
  // Regression for the 69-exit-rows / 12-real-positions / fabricated-$46k churn:
  // an exit order that comes back `needs_confirmation` never reduces the position, so
  // the loop used to re-fire it every ~8 min (the only guard was the timer), re-logging
  // the same unrealized P&L as realized. Now an in-flight exit freezes the symbol until
  // it actually leaves the book — independent of the timer.
  const SYM = 'SHOP';
  const saved = { ...process.env };
  const sells = [];
  let positions = [{ symbol: SYM, qty: 100, avg_entry_price: 125.0, current_price: 124.0, unrealized_pl: -100, pnl_pct: -0.8 }];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions,
    getIBKROpenOrders: async () => [],           // broker reports NO working order for the unconfirmed exit
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => {
      // Count only the EXIT sells (market/limit) — not the protective STP the
      // re-protect pass attaches to a naked long.
      if (/sell/i.test(o.side || '') && !/stop|stp/i.test(o.type || '')) sells.push(o);
      return { status: 'needs_confirmation' };   // the crux: exit never confirms/fills
    },
  };
  // A persistent, strong BEARISH ENTER on the held long → drives the signal-exit path
  // (no yahoo bars needed). Relax the unrelated anti-churn gates so the exit is eligible.
  const bearish = { symbol: SYM, direction: 'BEARISH', entry_price: 124.0, convergence: { decision: 'ENTER', p_win: 0.9 } };
  try {
    process.env.TRADER_AUTO_EXECUTE = '1';
    process.env.TRADER_MANAGE_EXITS = '0';
    process.env.TRADER_REQUIRE_PERSIST = '0';   // don't require consecutive scans
    process.env.TRADER_MIN_HOLD_MIN = '0';      // no min-hold block
    process.env.TRADER_EXIT_MIN_PWIN = '0';     // any bearish is strong enough
    process.env.TRADER_MOMENTUM_EXIT = '0';     // isolate the signal-exit path
    process.env.TRADER_EXIT_REATTEMPT_MIN = '8';
    at._resetCooldowns();

    const t0 = 1_700_000_000_000;
    const r1 = await at.runAutoTrade({ signals: [bearish] }, { bridge, userId: 'u', now: t0 });
    assert.strictEqual(sells.length, 1, 'scan 1 fires exactly one exit sell');
    assert.ok(r1.executed.some((e) => e.action === 'exit_long'), 'scan 1 logged the exit');

    // Scan 2, NINE minutes later — the 8-min reattempt timer has EXPIRED, so only the
    // in-flight freeze can stop a re-fire. Position is still held (exit never confirmed).
    const r2 = await at.runAutoTrade({ signals: [bearish] }, { bridge, userId: 'u', now: t0 + 9 * 60000 });
    assert.strictEqual(sells.length, 1, 'scan 2 does NOT re-fire the exit (in-flight freeze)');
    assert.ok(r2.skipped.some((s) => /oversell|stacking|resting/i.test(s.why || '')), 'scan 2 skipped via the oversell/in-flight guard');

    // Position finally leaves the book (the exit filled). The freeze clears, so a fresh
    // future position could be exited again.
    positions = [];
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 'u', now: t0 + 20 * 60000 });
    const snap = JSON.parse(fs.readFileSync(at.STATE_FILE, 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(snap.exitStatus || {}, SYM), 'freeze cleared once the position left the book');
  } finally {
    process.env = saved;
    at._resetCooldowns();
  }
});

test('max-loss backstop: a long past -maxLossPct is market-exited even inside min-hold', async () => {
  // Regression for the "-17% TSLA never exited" bug: a losing position whose broker
  // protective stop never placed/filled must still be cut by the hard max-loss backstop,
  // regardless of momentum or a just-opened min-hold window.
  const saved = { ...process.env };
  const exitSells = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    // TSLA down 10% (below the 8% default backstop); freshly "opened" so min-hold would
    // otherwise block an exit.
    getIBKRPositions: async () => [{ symbol: 'TSLA', qty: 10, avg_entry_price: 100, current_price: 90, market_value: 900, unrealized_pl: -100 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => {
      if (/sell/i.test(o.side || '') && !/stop|stp/i.test(o.type || '')) exitSells.push(o);   // the exit, not the protective STP
      return { status: 'placed' };
    },
  };
  try {
    process.env.TRADER_MANAGE_EXITS = '1';       // exits-only mode is enough to run manageHeldExits
    process.env.TRADER_AUTO_EXECUTE = '0';
    process.env.TRADER_MOMENTUM_EXIT = '0';      // isolate the max-loss path (no bar fetch)
    process.env.TRADER_MIN_HOLD_MIN = '30';      // min-hold would block a normal exit…
    process.env.TRADER_MAX_LOSS_PCT = '8';
    at._resetCooldowns();
    const now = 1_700_000_000_000;
    at._saveState();   // ensure clean state
    const out = await at.runAutoTrade({ signals: [] }, { bridge, userId: 'u', now });
    assert.strictEqual(exitSells.length, 1, 'the -10% loser is market-exited by the backstop');
    assert.ok(out.executed.some((e) => e.action === 'exit_long' && /max_loss/.test(e.reason || '')), 'exit reason is max_loss');
  } finally {
    process.env = saved;
    at._resetCooldowns();
  }
});

test('max-loss backstop: a small loss inside the threshold is NOT force-exited', async () => {
  const saved = { ...process.env };
  const exitSells = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'AAPL', qty: 10, avg_entry_price: 100, current_price: 97, market_value: 970, unrealized_pl: -30 }], // -3%, above the 8% floor
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { if (/sell/i.test(o.side || '') && !/stop|stp/i.test(o.type || '')) exitSells.push(o); return { status: 'placed' }; },
  };
  try {
    process.env.TRADER_MANAGE_EXITS = '1';
    process.env.TRADER_AUTO_EXECUTE = '0';
    process.env.TRADER_MOMENTUM_EXIT = '0';
    process.env.TRADER_MIN_HOLD_MIN = '0';
    process.env.TRADER_MAX_LOSS_PCT = '8';
    at._resetCooldowns();
    const out = await at.runAutoTrade({ signals: [] }, { bridge, userId: 'u', now: 1_700_000_000_000 });
    assert.strictEqual(exitSells.length, 0, 'a -3% position is left alone (broker stop handles it)');
  } finally {
    process.env = saved;
    at._resetCooldowns();
  }
});

test('R take-profit: a long at +1R is banked; below 1R it is held', async () => {
  const saved = { ...process.env };
  const mk = (curPx) => ({
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'SPY', qty: 10, avg_entry_price: 100, current_price: curPx, market_value: 10 * curPx, unrealized_pl: (curPx - 100) * 10 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { if (/sell/i.test(o.side || '') && !/stop|stp/i.test(o.type || '')) mk._sells.push(o); return { status: 'placed' }; },
  });
  async function run(curPx) {
    const b = mk(curPx); b.placeIBKROrder = async (uid, o) => { if (/sell/i.test(o.side || '') && !/stop|stp/i.test(o.type || '')) sells.push(o); return { status: 'placed' }; };
    return b;
  }
  let sells = [];
  try {
    process.env.TRADER_MANAGE_EXITS = '1';
    process.env.TRADER_AUTO_EXECUTE = '0';
    process.env.TRADER_MOMENTUM_EXIT = '0';
    process.env.TRADER_MIN_HOLD_MIN = '0';
    process.env.TRADER_STOP_PCT = '2';
    process.env.TRADER_TAKE_PROFIT_R = '1';   // 1R = +2% (stopPct)
    // +2.5% → past 1R → should bank it
    sells = []; at._resetCooldowns();
    let out = await at.runAutoTrade({ signals: [] }, { bridge: await run(102.5), userId: 'u', now: 1_700_000_000_000 });
    assert.strictEqual(sells.length, 1, 'a +2.5% long (>1R) is taken-profit');
    assert.ok(out.executed.some((e) => /take_profit_R/.test(e.reason || '')), 'reason is take_profit_R');
    // +1% → below 1R → left to run
    sells = []; at._resetCooldowns();
    await at.runAutoTrade({ signals: [] }, { bridge: await run(101), userId: 'u', now: 1_700_000_000_000 });
    assert.strictEqual(sells.length, 0, 'a +1% long (<1R) is held');
  } finally {
    process.env = saved;
    at._resetCooldowns();
  }
});

test('entryKnifeFilter config defaults on, disables via env', () => {
  const saved = process.env.TRADER_ENTRY_KNIFE_FILTER;
  try {
    delete process.env.TRADER_ENTRY_KNIFE_FILTER;
    assert.strictEqual(at.cfg().entryKnifeFilter, true);
    process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
    assert.strictEqual(at.cfg().entryKnifeFilter, false);
  } finally {
    if (saved === undefined) delete process.env.TRADER_ENTRY_KNIFE_FILTER; else process.env.TRADER_ENTRY_KNIFE_FILTER = saved;
  }
});
