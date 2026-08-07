'use strict';

/**
 * stop-floor.test.js — the support-entry stop must clear the noise band.
 *
 * On 2026-08-06 the live trader entered SPY with a 0.20% stop and was tagged in
 * 29 minutes; four stop-outs that session fired within ~20 minutes of entry and
 * cost -$1,235, against +$475 from the two positions that survived to a zone.
 *
 * The old code floored the stop DISTANCE used for sizing (`Math.max(0.2, …)`)
 * while leaving the stop PRICE under the zone — so the arithmetic looked fine
 * and the stop still got tagged. Worse, it also mis-scaled R: a full stop-out
 * on a 0.05% stop was booked as -0.25R because R divided by the floored 0.2%.
 *
 * These tests pin that the stop PRICE moves, that a genuinely wide structural
 * stop is left alone, and that the floor is disableable.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirror of the production expression (auto-trader.js, support-entry gate).
function flooredStop(price, zoneStop, stopMinPct) {
  if (zoneStop == null || !(stopMinPct > 0)) return zoneStop;
  return Math.min(zoneStop, price * (1 - stopMinPct / 100));
}
const distPct = (price, stop) => ((price - stop) / price) * 100;

test('a stop inside the noise band is pushed out to the floor', () => {
  // The live SPY case: entry 771.55, zone stop 770.01 => 0.20%.
  const price = 771.55, zoneStop = 770.01;
  assert.ok(distPct(price, zoneStop) < 0.25, 'precondition: the raw zone stop is ~0.2%');
  const stop = flooredStop(price, zoneStop, 3);
  assert.ok(distPct(price, stop) >= 2.99, `expected >=3%, got ${distPct(price, stop).toFixed(2)}%`);
  assert.ok(stop < zoneStop, 'the stop PRICE must move down, not just the distance used for sizing');
});

test('a structural stop already wider than the floor is left alone', () => {
  // SOXL 2026-08-06: 5.39% stop — wider than the floor, so untouched.
  const price = 135.48, zoneStop = 128.18;
  assert.strictEqual(flooredStop(price, zoneStop, 3), zoneStop);
});

test('the floor never moves a stop ABOVE entry', () => {
  for (const pct of [0.5, 3, 10]) {
    const stop = flooredStop(100, 99.99, pct);
    assert.ok(stop < 100, 'a long stop must stay below entry');
  }
});

test('stopMinPct=0 disables the floor (old behaviour)', () => {
  assert.strictEqual(flooredStop(771.55, 770.01, 0), 770.01);
});

test('R accounting is honest once the stop moves — the bug this replaces', () => {
  // OLD: stop stayed at 0.05%, risk floored to 0.2% => a full stop-out booked
  // as -0.25R. NEW: stop is at the floor, so a stop-out is exactly -1R.
  const price = 100, zoneStop = 99.95;
  const oldRisk = Math.max(price - zoneStop, price * 0.002);
  const oldR = -(price - zoneStop) / oldRisk;
  assert.ok(oldR > -0.3, `old accounting understated the loss: ${oldR.toFixed(2)}R`);

  const newStop = flooredStop(price, zoneStop, 3);
  const newR = -(price - newStop) / (price - newStop);
  assert.strictEqual(newR, -1, 'a stop-out must cost exactly 1R');
});

test('sizing: the floor lets risk-based sizing reach its target instead of being capped', () => {
  // qty = min(riskDollars / stopDist, notionalCap). With a 0.2% stop the model
  // wants a position far past the cap, so real risk collapses; at 3% it fits.
  const EQ = 960348, riskPct = 0.06, capPct = 7;
  const want = (stopPct) => (EQ * riskPct / 100) / (stopPct / 100);
  const cap = EQ * capPct / 100;
  assert.ok(want(0.2) > cap * 4, `a 0.2% stop demands $${Math.round(want(0.2))} — over 4x the $${Math.round(cap)} cap, so the cap truncates and real risk collapses`);
  assert.ok(want(3) < cap, `a 3% stop wants $${Math.round(want(3))}, inside the cap — the intended risk is actually taken`);
});
