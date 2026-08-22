'use strict';
/**
 * symbol-tilt.test.js — TRADER_SYMBOL_SIZE_MULT (#3434 stack-sweep lab): per-
 * symbol size weights chosen on the fit surfaces, confirmed on holdout.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tilt-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
delete process.env.TRADER_SYMBOL_SIZE_MULT;
const at = require('../lib/auto-trader');

const SPEC = 'SOXL:1.5,SMH:1.5,QQQ:1.5,XLK:1.0,IWM:1.02,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5';

test('unset -> flat (1 for everything)', () => {
  assert.strictEqual(at._symbolSizeMult('SOXL'), 1);
  assert.strictEqual(at._symbolSizeMult('SOXL', ''), 1);
});

test('the validated weights parse, case-insensitively, and unknown symbols stay flat', () => {
  assert.strictEqual(at._symbolSizeMult('SOXL', SPEC), 1.5);
  assert.strictEqual(at._symbolSizeMult('tlt', SPEC), 0.5);
  assert.strictEqual(at._symbolSizeMult('DIA', SPEC), 0.71);
  assert.strictEqual(at._symbolSizeMult('XLF', SPEC), 1, 'not in the spec -> flat');
});

test('malformed or absurd weights are neutralised or clamped', () => {
  assert.strictEqual(at._symbolSizeMult('SPY', 'SPY:abc'), 1);
  assert.strictEqual(at._symbolSizeMult('SPY', 'SPY:-2'), 1);
  assert.strictEqual(at._symbolSizeMult('SPY', 'SPY:9'), 2, 'clamped to 2x');
  assert.strictEqual(at._symbolSizeMult('SPY', 'SPY:0.01'), 0.25, 'clamped to 0.25x');
});

test('the sizing path: the weight scales cap and risk together (18% on SOXL, 6% on TLT at a $1M book)', () => {
  const eq = 1000000, px = 100;
  const flat = at.sizePosition({ equity: eq, price: px, positionPct: 12, maxPositionPct: 12, riskPct: 0.36, stopDistPct: 3 });
  const soxl = at.sizePosition({ equity: eq, price: px, positionPct: 12, maxPositionPct: 12 * 1.5, riskPct: 0.36 * 1.5, stopDistPct: 3 });
  const tlt = at.sizePosition({ equity: eq, price: px, positionPct: 12, maxPositionPct: 12 * 0.5, riskPct: 0.36 * 0.5, stopDistPct: 3 });
  assert.strictEqual(flat, 1200);
  assert.strictEqual(soxl, 1800);
  assert.strictEqual(tlt, 600);
});
