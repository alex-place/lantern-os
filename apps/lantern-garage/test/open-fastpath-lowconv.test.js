'use strict';

/**
 * open-fastpath-lowconv.test.js — the two 2026-08-11 session-analysis changes.
 *
 * 1. OPENING FAST-PATH: two consecutive sessions missed their biggest washout
 *    bounces at 09:45-09:55 (SLV +3.7%, GLD +1.65% Mon; SOXL +2.72%, TQQQ
 *    +1.36% Tue) because 2-scan persistence eats the open. One scan suffices
 *    inside 09:30-10:00 ET; every other gate still applies.
 * 2. LOW-CONVICTION SIZE CUT: on the first red-drift session every sub-0.5
 *    p_win entry underperformed while every >=0.55 entry won. Below the
 *    coin-flip line the position is a probe: multiplier hard-capped at 0.5x.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production expressions in auto-trader.js.
const needScans = (etMin, persistScans, fastpathOff) =>
  (!fastpathOff && etMin >= 570 && etMin < 600) ? 1 : persistScans;
const effMult = (sizeMult, pWin, lowConvMult) =>
  (lowConvMult > 0 && Number(pWin) > 0 && Number(pWin) < 0.5) ? Math.min(sizeMult, lowConvMult) : sizeMult;

const MIN = (h, m) => h * 60 + m;

test('inside the opening window one scan suffices', () => {
  assert.strictEqual(needScans(MIN(9, 31), 2, false), 1);
  assert.strictEqual(needScans(MIN(9, 45), 2, false), 1, 'the 09:45 washouts both days');
  assert.strictEqual(needScans(MIN(9, 59), 2, false), 1);
});

test('outside the window the anti-churn persistence is unchanged', () => {
  assert.strictEqual(needScans(MIN(10, 0), 2, false), 2, 'window closes AT 10:00');
  assert.strictEqual(needScans(MIN(9, 29), 2, false), 2, 'pre-open scan is not the window');
  assert.strictEqual(needScans(MIN(14, 30), 2, false), 2);
});

test('TRADER_OPEN_FASTPATH=0 disables the window', () => {
  assert.strictEqual(needScans(MIN(9, 45), 2, true), 2);
});

test('sub-coin-flip conviction is capped at the probe size', () => {
  assert.strictEqual(effMult(0.76, 0.4516, 0.5), 0.5, 'the QQQ 0.452 entry sized 0.76x live');
  assert.strictEqual(effMult(1.0, 0.483, 0.5), 0.5, 'the XLK loser');
  assert.strictEqual(effMult(0.4, 0.45, 0.5), 0.4, 'an already-smaller mult is never raised');
});

test('at or above 0.5 the conviction curve is untouched', () => {
  assert.strictEqual(effMult(0.76, 0.5, 0.5), 0.76);
  assert.strictEqual(effMult(1.2, 0.6189, 0.5), 1.2, 'the SOXL winner');
});

test('TRADER_LOWCONV_MULT=0 disables; missing p_win never triggers the cut', () => {
  assert.strictEqual(effMult(0.9, 0.45, 0), 0.9);
  assert.strictEqual(effMult(0.9, null, 0.5), 0.9);
  assert.strictEqual(effMult(0.9, undefined, 0.5), 0.9);
});
