'use strict';

/**
 * gate-allows.test.js — rileyGate as a VETO is opt-out (RILEY_GATE=0).
 *
 * Measured over 31,293 daily bars (experiments/entry_edge_test.js), rileyGate
 * discards ~46% of candidates and the survivors have LOWER forward returns than
 * the pool it selected from — at every horizon (1/5/10/20 bars) and with the
 * trend flag both on and off, 6 of 6. Removing the veto in the backtest lab was
 * better in BOTH the fit and holdout windows on BOTH total R and avg R, and
 * improved all 5 symbols on total R.
 *
 * The gate is still COMPUTED either way (confidence/quality/reason stay on the
 * signal); the flag only decides whether it may block a trade.
 */

const test = require('node:test');
const assert = require('node:assert');
const { gateAllows, rileyGate } = require('../lib/signal-engine/scan');

const OK = { actionable: true };
const NO = { actionable: false };

test('default: the gate still vetoes (shipped behaviour unchanged)', () => {
  assert.strictEqual(gateAllows(OK, { rileyGate: '1' }), true);
  assert.strictEqual(gateAllows(NO, { rileyGate: '1' }), false);
});

test('RILEY_GATE=0: the gate no longer vetoes', () => {
  assert.strictEqual(gateAllows(NO, { rileyGate: '0' }), true);
  assert.strictEqual(gateAllows(OK, { rileyGate: '0' }), true);
});

test('the env var drives it when no explicit opt is passed', () => {
  const saved = process.env.RILEY_GATE;
  try {
    delete process.env.RILEY_GATE;
    assert.strictEqual(gateAllows(NO), false, 'unset must keep the veto');
    process.env.RILEY_GATE = '0';
    assert.strictEqual(gateAllows(NO), true);
    process.env.RILEY_GATE = '1';
    assert.strictEqual(gateAllows(NO), false);
  } finally {
    if (saved === undefined) delete process.env.RILEY_GATE; else process.env.RILEY_GATE = saved;
  }
});

test('a malformed/absent gate result never crashes the scan', () => {
  for (const bad of [null, undefined, {}]) {
    assert.strictEqual(gateAllows(bad, { rileyGate: '1' }), false);
    assert.strictEqual(gateAllows(bad, { rileyGate: '0' }), true);
  }
});

test('the gate is still COMPUTED — confidence/quality survive for logging', () => {
  // Far from any zone: the gate refuses, but must still hand back a usable
  // verdict, because the signal keeps carrying it even when it cannot veto.
  const g = rileyGate({
    sr: { in_zone: false, dist_to_nearest: 99, nearest_zone: {}, zone_strength: 0 },
    rsiVal: 50, thresholds: { oversold: 30, overbought: 70 },
    struct: {}, candle: {}, direction: 'BULLISH', trending: false,
  });
  assert.strictEqual(g.actionable, false);
  assert.strictEqual(typeof g.confidence, 'number');
  assert.ok(g.reason && g.reason.length, 'reason must survive for the skip log');
  assert.strictEqual(gateAllows(g, { rileyGate: '0' }), true, 'flag overrides the veto, not the computation');
});
