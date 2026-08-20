'use strict';
// morning-depth.test.js — TRADER_IBS_MAX_MORNING: a deeper washout bar before
// 11:00 ET, default OFF (pilot-only evidence; the two-window gate owns the
// core signal). opts.etMin injects the clock for tests.
const { test } = require('node:test');
const assert = require('node:assert');
process.env.TRADER_IBS_MODE = 'only';
const { deriveDirection } = require('../lib/signal-engine/scan');
const D = (ibs, etMin) => deriveDirection({}, 50, { oversold: 30, overbought: 70 }, { ibs, etMin });

test('default OFF: 0.12 IBS enters at 10:00 exactly as today', () => {
  delete process.env.TRADER_IBS_MAX_MORNING;
  assert.strictEqual(D(0.12, 600), 'BULLISH');
});
test('morning bar: 0.12 refused before 11:00, 0.07 accepted', () => {
  process.env.TRADER_IBS_MAX_MORNING = '0.08';
  try {
    assert.strictEqual(D(0.12, 600), 'NEUTRAL', 'shallow first-touch filtered in the morning');
    assert.strictEqual(D(0.07, 585), 'BULLISH', 'the real 09:45-class washout still enters');
    assert.strictEqual(D(0.12, 700), 'BULLISH', 'after 11:00 the standard 0.15 bar applies');
  } finally { delete process.env.TRADER_IBS_MAX_MORNING; }
});
test('boundary: 11:00 itself uses the standard bar', () => {
  process.env.TRADER_IBS_MAX_MORNING = '0.08';
  try { assert.strictEqual(D(0.12, 660), 'BULLISH'); }
  finally { delete process.env.TRADER_IBS_MAX_MORNING; }
});
