'use strict';

/**
 * ibs-entry.test.js — Internal Bar Strength entry signal (TRADER_IBS_MODE).
 *
 * Research 2026-08-08: judged on ALL factors (per-trade, win rate, volume,
 * total income), IBS<0.15 alone dominated the RSI baseline OOS 2015-26 —
 * 658% vs 297% total captured — and RSI∪IBS added no total beyond IBS alone.
 * These tests pin the signal math and the env gating; default is OFF.
 */

const test = require('node:test');
const assert = require('node:assert');
const { deriveDirection, sessionIbs } = require('../lib/signal-engine/scan');

const bar = (ts, h, l, c) => ({ timestamp: ts, high: h, low: l, close: c });

test('sessionIbs: close at the session low -> 0, at the high -> 1', () => {
  const d = '2026-08-10';
  assert.strictEqual(sessionIbs([bar(`${d}T14:30:00Z`, 110, 100, 100)]), 0);
  assert.strictEqual(sessionIbs([bar(`${d}T14:30:00Z`, 110, 100, 110)]), 1);
});

test('sessionIbs: only the LAST session date counts — yesterday cannot widen the range', () => {
  const bars = [
    bar('2026-08-07T19:45:00Z', 200, 90, 95),   // huge prior-day range must be ignored
    bar('2026-08-10T14:30:00Z', 110, 100, 101),
    bar('2026-08-10T14:45:00Z', 108, 102, 103),
  ];
  // today's range 100-110, close 103 -> 0.3
  assert.ok(Math.abs(sessionIbs(bars) - 0.3) < 1e-9);
});

test('sessionIbs: degenerate range or no bars -> null, never NaN', () => {
  assert.strictEqual(sessionIbs([]), null);
  assert.strictEqual(sessionIbs(null), null);
  assert.strictEqual(sessionIbs([bar('2026-08-10T14:30:00Z', 100, 100, 100)]), null);
});

test('mode=only: IBS below the max is the ONLY long trigger', () => {
  process.env.TRADER_IBS_MODE = 'only';
  try {
    const sr = { in_zone: false, nearest_zone: { type: 'SUPPORT' } };   // would be BULLISH normally
    assert.strictEqual(deriveDirection(sr, 50, { oversold: 30, overbought: 70 }, { ibs: 0.10 }), 'BULLISH');
    assert.strictEqual(deriveDirection(sr, 20, { oversold: 30, overbought: 70 }, { ibs: 0.50 }), 'NEUTRAL',
      'even an oversold RSI near support must not fire when IBS says mid-range');
    assert.strictEqual(deriveDirection(sr, 20, { oversold: 30, overbought: 70 }, { ibs: null }), 'NEUTRAL',
      'missing IBS -> no signal, never a guess');
  } finally { delete process.env.TRADER_IBS_MODE; }
});

test('mode=or: IBS adds entries, zone/RSI logic still works', () => {
  process.env.TRADER_IBS_MODE = 'or';
  try {
    const none = { in_zone: false, nearest_zone: {} };
    assert.strictEqual(deriveDirection(none, 50, { oversold: 30, overbought: 70 }, { ibs: 0.10 }), 'BULLISH');
    const sup = { in_zone: false, nearest_zone: { type: 'SUPPORT' } };
    assert.strictEqual(deriveDirection(sup, 50, { oversold: 30, overbought: 70 }, { ibs: 0.90 }), 'BULLISH',
      'zone logic must survive when IBS does not fire');
  } finally { delete process.env.TRADER_IBS_MODE; }
});

test('mode unset: behavior is EXACTLY the pre-IBS logic (default off)', () => {
  const sup = { in_zone: false, nearest_zone: { type: 'SUPPORT' } };
  assert.strictEqual(deriveDirection(sup, 50, { oversold: 30, overbought: 70 }, { ibs: 0.01 }), 'BULLISH');
  const none = { in_zone: false, nearest_zone: {} };
  assert.strictEqual(deriveDirection(none, 50, { oversold: 30, overbought: 70 }, { ibs: 0.01 }), 'NEUTRAL',
    'a screaming IBS must change NOTHING while the mode is off');
});

test('TRADER_IBS_MAX tunes the threshold', () => {
  process.env.TRADER_IBS_MODE = 'only';
  process.env.TRADER_IBS_MAX = '0.3';
  try {
    assert.strictEqual(deriveDirection({ in_zone: false, nearest_zone: {} }, 50, { oversold: 30, overbought: 70 }, { ibs: 0.25 }), 'BULLISH');
  } finally { delete process.env.TRADER_IBS_MODE; delete process.env.TRADER_IBS_MAX; }
});
