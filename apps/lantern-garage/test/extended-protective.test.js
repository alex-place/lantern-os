'use strict';

/**
 * extended-protective.test.js — extended-hours PROTECTIVE mode (2026-08-12).
 *
 * Motivating incident: between 16:00 and 09:30 the scan loop is idle, so a
 * winner's trailing floor is never evaluated. On 2026-08-12 SOXS sat at +$3,617
 * exactly on its R2 target — riding a trail that could not ratchet — and gave
 * back into the after-hours session with only the -3% GTC stop underneath.
 * 17.5 hours of every weekday the book was unmanaged.
 *
 * The contract this pins:
 *   - protective mode RUNS the loop in pre/after-hours,
 *   - takes NO entries (IBS is undefined without a session range, and no lab
 *     gate covers extended-hours entries),
 *   - allows PRICE-THRESHOLD exits (r2_trail, zone floors, giveback, trailing
 *     stop, targets, max_loss),
 *   - blocks SIGNAL-derived exits (momentum_died, the bearish signal_exit),
 *     because those reads come off thin extended-session bars.
 */

const test = require('node:test');
const assert = require('node:assert');

// ── window selection (mirrors routes/trading.js) ────────────────────────────
const isMarketHours = (mins, day) => day >= 1 && day <= 5 && mins >= 570 && mins < 960;
const isExtended = (mins, day) => day >= 1 && day <= 5 && ((mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200));
const windowFor = (mins, day, { extendedTrading = false, extendedExits = false } = {}) => {
  const marketHours = isMarketHours(mins, day);
  const extNow = isExtended(mins, day) && extendedTrading;
  const extManageNow = !marketHours && !extNow && isExtended(mins, day) && extendedExits;
  return { runs: marketHours || extNow || extManageNow, protectiveOnly: extManageNow };
};

const T = (h, m = 0) => h * 60 + m;

test('after-hours with the flag on: the loop RUNS, in protective mode', () => {
  const w = windowFor(T(17), 3, { extendedExits: true });   // 17:00 ET Wednesday
  assert.strictEqual(w.runs, true, 'the loop must run — that is the whole point');
  assert.strictEqual(w.protectiveOnly, true);
});

test('pre-market with the flag on: runs protectively (the 04:00-09:30 window)', () => {
  const w = windowFor(T(8, 30), 4, { extendedExits: true });
  assert.deepStrictEqual(w, { runs: true, protectiveOnly: true });
});

test('regular hours are NEVER protective — full trading resumes at 09:30', () => {
  const w = windowFor(T(9, 30), 3, { extendedExits: true });
  assert.strictEqual(w.runs, true);
  assert.strictEqual(w.protectiveOnly, false, 'entries must be live again in RTH');
});

test('flag OFF: after-hours stays idle exactly as before', () => {
  assert.deepStrictEqual(windowFor(T(17), 3, { extendedExits: false }), { runs: false, protectiveOnly: false });
});

test('full extended trading supersedes protective mode (no double-gating)', () => {
  const w = windowFor(T(17), 3, { extendedTrading: true, extendedExits: true });
  assert.strictEqual(w.runs, true);
  assert.strictEqual(w.protectiveOnly, false, 'if the operator enabled full extended trading, entries are allowed');
});

test('overnight and weekends stay idle — 20:00-04:00 is not an extended session', () => {
  assert.strictEqual(windowFor(T(2), 3, { extendedExits: true }).runs, false, '02:00 ET');
  assert.strictEqual(windowFor(T(21), 3, { extendedExits: true }).runs, false, '21:00 ET');
  assert.strictEqual(windowFor(T(17), 6, { extendedExits: true }).runs, false, 'Saturday');
  assert.strictEqual(windowFor(T(17), 0, { extendedExits: true }).runs, false, 'Sunday');
});

// ── exit classification (mirrors the gates in auto-trader.js) ───────────────
// Signal-derived exits are suppressed; price-threshold exits are allowed.
const SIGNAL_DERIVED = new Set(['momentum_died', 'signal_exit']);
const exitAllowed = (kind, protectiveOnly) => !(protectiveOnly && SIGNAL_DERIVED.has(kind));

test('the SOXS case: r2_trail still fires after hours — the reason this exists', () => {
  assert.strictEqual(exitAllowed('r2_trail', true), true);
});

test('every price-threshold exit survives protective mode', () => {
  for (const k of ['r2_trail', 'zone_r1_floor', 'zone_r1', 'zone_r2', 'peak_giveback', 'trailing_stop', 'take_profit_R', 'max_loss']) {
    assert.strictEqual(exitAllowed(k, true), true, k + ' protects capital and must still fire');
  }
});

test('signal-derived exits are suppressed after hours, live in regular hours', () => {
  assert.strictEqual(exitAllowed('momentum_died', true), false, 'MACD/EMA/RSI on thin bars is noise');
  assert.strictEqual(exitAllowed('signal_exit', true), false);
  assert.strictEqual(exitAllowed('momentum_died', false), true, 'unchanged during RTH');
  assert.strictEqual(exitAllowed('signal_exit', false), true);
});

test('entry candidates are emptied in protective mode, untouched otherwise', () => {
  const enters = [{ symbol: 'SOXL' }, { symbol: 'TQQQ' }];
  const candidates = (protectiveOnly) => (protectiveOnly ? [] : enters);
  assert.strictEqual(candidates(true).length, 0, 'no extended-hours entries — IBS has no session range');
  assert.strictEqual(candidates(false).length, 2);
});
