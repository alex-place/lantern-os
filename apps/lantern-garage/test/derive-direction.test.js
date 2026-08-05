'use strict';

/**
 * derive-direction.test.js — the trend override on the direction primitive.
 *
 * The zone rules are pure mean-reversion: nearest zone is resistance -> BEARISH.
 * In an uptrend price sits near its highs by definition, so that read is
 * permanently BEARISH on exactly the instruments that are going up. Measured
 * 2026-08-05: GLD read BEARISH on all 49 intraday bars while climbing +2.0%.
 *
 * These tests pin that the override fires ONLY in a confirmed uptrend, that it
 * still respects overbought, and that with the flag off behaviour is byte-identical
 * to the shipped mean-reversion logic.
 */

const test = require('node:test');
const assert = require('node:assert');
const { deriveDirection } = require('../lib/signal-engine/scan');

const TH = { oversold: 30, overbought: 70 };

// closes: a clean uptrend (price > SMA20 > SMA50) and a clean downtrend.
const UP = Array.from({ length: 80 }, (_, i) => 100 + i);
const DOWN = Array.from({ length: 80 }, (_, i) => 200 - i);
const FLAT = Array.from({ length: 80 }, () => 100);

const atResistance = { in_zone: true, zone_type: 'RESISTANCE', nearest_zone: { type: 'RESISTANCE' } };
const nearResistance = { in_zone: false, nearest_zone: { type: 'RESISTANCE' } };
const atSupport = { in_zone: true, zone_type: 'SUPPORT', nearest_zone: { type: 'SUPPORT' } };

test('flag OFF: resistance still reads BEARISH (shipped behaviour unchanged)', () => {
  assert.strictEqual(deriveDirection(atResistance, 50, TH, { trendDir: false, closes: UP }), 'BEARISH');
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: false, closes: UP }), 'BEARISH');
});

test('flag ON + uptrend: resistance is a TARGET, not a short — this is the GLD case', () => {
  assert.strictEqual(deriveDirection(atResistance, 50, TH, { trendDir: true, closes: UP }), 'BULLISH');
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: true, closes: UP }), 'BULLISH');
});

test('flag ON + downtrend: resistance still reads BEARISH — the override must not invert everything', () => {
  assert.strictEqual(deriveDirection(atResistance, 50, TH, { trendDir: true, closes: DOWN }), 'BEARISH');
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: true, closes: DOWN }), 'BEARISH');
});

test('flag ON + flat tape: no trend, so no override', () => {
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: true, closes: FLAT }), 'BEARISH');
});

test('overbought still vetoes the chase even in an uptrend', () => {
  assert.strictEqual(deriveDirection(nearResistance, 75, TH, { trendDir: true, closes: UP }), 'BEARISH');
});

test('support is BULLISH regardless of flag or trend', () => {
  for (const closes of [UP, DOWN, FLAT]) {
    for (const trendDir of [true, false]) {
      assert.strictEqual(deriveDirection(atSupport, 50, TH, { trendDir, closes }), 'BULLISH');
    }
  }
});

test('too little history to judge trend -> no override (fail safe)', () => {
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: true, closes: [1, 2, 3] }), 'BEARISH');
  assert.strictEqual(deriveDirection(nearResistance, 50, TH, { trendDir: true }), 'BEARISH');
});
