'use strict';
/**
 * defer-ext-exit.test.js — a price-threshold exit may DECIDE outside regular hours,
 * but it must not FILL there (operator, 2026-08-26).
 *
 * SOXL, 2026-08-26: trailing_stop fired at 08:36 on a real, sustained pre-market fall
 * and filled at 113.52. The regular session opened at 115.54 and ran to 117.19. The
 * position realised -$2,647 where the same decision filled at the open would have been
 * roughly +$418.
 *
 * That was not bad luck. Measured over 59 days, 10 names, 580 symbol-days: after a
 * pre-market drawdown of -1.5% or worse the open was ABOVE the pre-market low 79% of
 * the time; after-hours is 88%. Every credible band in both windows reverts at the open.
 * (The deepest "drawdown" band had to be discarded — every one of its worst entries was
 * a ZERO-VOLUME Yahoo print, e.g. SPY -7.2% at 17:00 on no trades.)
 *
 * So: keep the decision, move the fill. #3378's reason for managing the extended session
 * is untouched — the position still leaves the book, just at 09:30.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deferext-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
// hermetic: pin the exit-authority switches to their ARMED production values so a real
// stock's momentum cannot decide this suite (see project trader test hygiene, #3459)
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => {
  at._deferredExit.clear();
  if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG);
};

test('the deferrable set is gain protection — never the disaster brake', () => {
  for (const r of ['trailing_stop (−3.3% from peak +2.0%, trig 2.5%)', 'take_profit_R (+3.0% ≈ 1R)',
    'take_profit (+5.0%)', 'peak_giveback', 'r2_trail', 'zone_floor']) {
    assert.strictEqual(at._isDeferrableExit(r), true, `${r} should defer`);
  }
  for (const r of ['max_loss (−10.0% ≤ -10%)', 'signal_exit', 'momentum_died (MACD hist<0)',
    'eod_flat_weekend', 'eod_decarry', '']) {
    assert.strictEqual(at._isDeferrableExit(r), false, `${r} must NOT defer`);
  }
});

test('max_loss is excluded by name, not by accident', () => {
  // the one exit that must still fill in the dark: the position is already at its cap
  assert.strictEqual(at._isDeferrableExit('max_loss'), false);
  assert.strictEqual(at._isDeferrableExit('MAX_LOSS'), false);
});

test('TRADER_EXT_DEFER_EXITS=0 reverts to filling in the dark', () => {
  const prev = process.env.TRADER_EXT_DEFER_EXITS;
  try {
    delete process.env.TRADER_EXT_DEFER_EXITS;
    assert.strictEqual(at._extDeferEnabled(), true, 'on by default');
    process.env.TRADER_EXT_DEFER_EXITS = '0';
    assert.strictEqual(at._extDeferEnabled(), false);
    process.env.TRADER_EXT_DEFER_EXITS = '1';
    assert.strictEqual(at._extDeferEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.TRADER_EXT_DEFER_EXITS; else process.env.TRADER_EXT_DEFER_EXITS = prev;
  }
});

// ---------------------------------------------------------------------------
// the end-to-end path, driven through the real exit machinery
// ---------------------------------------------------------------------------
function world({ qty = 1517, entry = 115.2640538, mark = 113.698, withStop = false } = {}) {
  at._resetCooldowns();
  const placed = [], cancels = [];
  // withStop: the position carries a working protective stop, so a cancel is observable.
  const stops = withStop ? [{ orderId: 'STP1', symbol: 'SOXL', side: 'sell', orderType: 'STP', status: 'Submitted', qty }] : [];
  return {
    placed, cancels,
    getIBKRAccount: async () => ({ equity: 966744, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'SOXL', qty, avg_entry_price: entry, current_price: mark,
      market_value: qty * mark, unrealized_pl: (mark - entry) * qty }],
    getIBKROpenOrders: async () => stops.map((o) => ({ ...o })),
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => {
      cancels.push(id);
      const o = stops.find((x) => x.orderId === id);
      if (o) o.status = 'Cancelled';
      return { status: 'cancelled', ok: true };
    },
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
}
const sells = (b) => b.placed.filter((o) => o.side === 'sell' && !/stop/i.test(o.type || ''));

test('EXTENDED: the trail decides, journals, and places NOTHING', async () => {
  reset();
  const b = world();
  await at._closeLongForTest(b, 'u', 'SOXL', 1517, { avg_entry_price: 115.264, current_price: 113.698 },
    'trailing_stop (−3.3% from peak +2.0%, trig 2.5%)', { skipped: [], executed: [] }, Date.now(),
    { extended: true, refPrice: 113.698 });
  assert.strictEqual(sells(b).length, 0, 'no order may reach the broker in the dark');
  assert.ok(at._deferredExit.has('SOXL'), 'the decision is recorded');
  const dep = rows().find((r) => r.event === 'exit_deferred');
  assert.ok(dep, 'and journaled, so the deferral is auditable');
  assert.match(String(dep.reason), /trailing_stop/);
});

test('REGULAR HOURS: the same trail fills immediately — nothing is deferred by daylight', async () => {
  reset();
  const b = world();
  await at._closeLongForTest(b, 'u', 'SOXL', 1517, { avg_entry_price: 115.264, current_price: 113.698 },
    'trailing_stop (−3.3% from peak +2.0%, trig 2.5%)', { skipped: [], executed: [] }, Date.now(), { extended: false });
  assert.strictEqual(sells(b).length, 1, 'RTH behaviour is unchanged');
  assert.strictEqual(at._deferredExit.has('SOXL'), false);
});

test('EXTENDED max_loss still fills in the dark — the brake is not deferred', async () => {
  reset();
  const b = world();
  await at._closeLongForTest(b, 'u', 'SOXL', 1517, { avg_entry_price: 115.264, current_price: 100 },
    'max_loss (−13.2% ≤ -10%)', { skipped: [], executed: [] }, Date.now(), { extended: true, refPrice: 100 });
  assert.strictEqual(sells(b).length, 1, 'a position at its loss cap must not wait');
  assert.strictEqual(at._deferredExit.has('SOXL'), false);
});

test('the deferred decision survives a restart', () => {
  reset();
  at._deferredExit.set('SOXL', { reason: 'trailing_stop', decidedAt: Date.now(), decidedPx: 113.698 });
  at._saveState();
  at._deferredExit.clear();
  at._loadState();
  assert.ok(at._deferredExit.has('SOXL'), 'an overnight decision cannot be lost to a restart');
  assert.match(String(at._deferredExit.get('SOXL').reason), /trailing_stop/);
});

test('AT THE OPEN: the deferred exit fills, and the decision is consumed', async () => {
  reset();
  const b = world();
  at._deferredExit.set('SOXL', { reason: 'trailing_stop (−3.3% from peak +2.0%)', decidedAt: Date.now() - 3600e3, decidedPx: 113.698 });
  await at._manageHeldExitsForTest({
    bridge: b, userId: 'u',
    heldPos: { SOXL: { symbol: 'SOXL', qty: 1517, avg_entry_price: 115.264, current_price: 115.54 } },
    heldQty: { SOXL: 1517 }, c: at.cfg(), now: Date.now(), out: { skipped: [], executed: [] }, extended: false,
  });
  assert.strictEqual(sells(b).length, 1, 'the open is where it fills');
  assert.strictEqual(at._deferredExit.size, 0, 'and the decision is consumed exactly once');
  assert.match(String(sells(b)[0].type), /market/i, 'RTH fills go out as a market order');
});

// Review H2 (2026-09-29): the deferral only held on the FIRST extended-hours check. The
// guard read `!_deferredExit.has(sym)`, so the second check fell through, cancelled the
// stop and sold into the dark print the feature exists to avoid.
test('EXTENDED, every later check: an exit already deferred still places nothing and keeps its stop', async () => {
  reset();
  const b = world({ withStop: true });
  const hp = { avg_entry_price: 115.264, current_price: 113.698 };
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    await at._closeLongForTest(b, 'u', 'SOXL', 1517, hp, 'trailing_stop (−3.3% from peak +2.0%, trig 2.5%)',
      { skipped: [], executed: [] }, t0 + i * 60e3, { extended: true, refPrice: 113.698 });
  }
  assert.strictEqual(sells(b).length, 0, 'the decision waits for the open on every check, not only the first');
  assert.deepStrictEqual(b.cancels, [], 'and the protective stop stays in place meanwhile');
  assert.ok(at._deferredExit.has('SOXL'));
  assert.strictEqual(rows().filter((r) => r.event === 'exit_deferred').length, 1, 'one decision, journaled once');
});

test('a real exit supersedes a pending deferral, so the open cannot sell the same shares again', async () => {
  reset();
  const b = world({ withStop: true });
  const hp = { avg_entry_price: 115.264, current_price: 113.698 };
  await at._closeLongForTest(b, 'u', 'SOXL', 1517, hp, 'trailing_stop (−3.3% from peak +2.0%)',
    { skipped: [], executed: [] }, Date.now(), { extended: true, refPrice: 113.698 });
  assert.ok(at._deferredExit.has('SOXL'));
  // later in the dark the position reaches its loss cap: the brake fills now
  await at._closeLongForTest(b, 'u', 'SOXL', 1517, { ...hp, current_price: 100 }, 'max_loss (−13.2% ≤ -10%)',
    { skipped: [], executed: [] }, Date.now(), { extended: true, refPrice: 100 });
  assert.strictEqual(sells(b).length, 1, 'the brake fills in the dark');
  assert.strictEqual(at._deferredExit.has('SOXL'), false, 'and the deferred decision it replaces is gone');
});

test('AT THE OPEN: a deferred exit does not stack on a sell already resting for the symbol', async () => {
  reset();
  const b = world();
  at._deferredExit.set('SOXL', { reason: 'trailing_stop', decidedAt: Date.now() - 3600e3, decidedPx: 113.698 });
  await at._manageHeldExitsForTest({
    bridge: b, userId: 'u',
    heldPos: { SOXL: { symbol: 'SOXL', qty: 1517, avg_entry_price: 115.264, current_price: 115.54 } },
    heldQty: { SOXL: 1517 }, c: at.cfg(), now: Date.now(), out: { skipped: [], executed: [] }, extended: false,
    workingSells: new Set(['SOXL']),
  });
  assert.strictEqual(sells(b).length, 0, 'the resting sell closes it; a second one would oversell');
  assert.strictEqual(at._deferredExit.size, 0, 'the decision is consumed');
});

test('a position that left the book overnight does not resurrect as a sell', async () => {
  reset();
  const b = world();
  at._deferredExit.set('SOXL', { reason: 'trailing_stop', decidedAt: Date.now() - 3600e3, decidedPx: 113.698 });
  await at._manageHeldExitsForTest({
    bridge: b, userId: 'u', heldPos: {}, heldQty: {}, c: at.cfg(),
    now: Date.now(), out: { skipped: [], executed: [] }, extended: false,
  });
  assert.strictEqual(sells(b).length, 0, 'nothing held — nothing to sell');
  assert.strictEqual(at._deferredExit.size, 0, 'the stale decision is dropped, not carried');
});
