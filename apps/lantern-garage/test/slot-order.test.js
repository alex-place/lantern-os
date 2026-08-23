'use strict';
/**
 * slot-order.test.js — TRADER_SLOT_ORDER (round-7 lab F): the admission order
 * of same-scan entry candidates when slots are scarce. 26y holdout: arbitrary
 * 643% / deepest-IBS 1,494% / highest tilt weight then depth 2,866%. Pure
 * helper; default keeps the scan's (confidence) order.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

const sig = (symbol, ibs) => ({ symbol, ibs, direction: 'BULLISH', convergence: { decision: 'ENTER', p_win: 0.6 } });
const SCAN = [sig('TLT', 0.05), sig('SOXL', 0.28), sig('SPY', 0.12), sig('SMH', 0.20), sig('GLD', 0.28)];
const names = (a) => a.map((s) => s.symbol);

test('unset / confidence / junk: the scan order is kept and nothing is dropped', () => {
  assert.deepStrictEqual(names(at._orderEntries(SCAN, undefined)), ['TLT', 'SOXL', 'SPY', 'SMH', 'GLD']);
  assert.deepStrictEqual(names(at._orderEntries(SCAN, 'confidence')), ['TLT', 'SOXL', 'SPY', 'SMH', 'GLD']);
  assert.deepStrictEqual(names(at._orderEntries(SCAN, 'banana')), ['TLT', 'SOXL', 'SPY', 'SMH', 'GLD']);
  assert.deepStrictEqual(at._orderEntries([], 'expectancy'), []);
});

test('depth: deepest session IBS first; missing readings sort last; ties keep scan order', () => {
  const withNull = [...SCAN, { symbol: 'DIA', direction: 'BULLISH', convergence: { decision: 'ENTER' } }];
  assert.deepStrictEqual(names(at._orderEntries(withNull, 'depth')), ['TLT', 'SPY', 'SMH', 'SOXL', 'GLD', 'DIA']);
});

test('expectancy: highest TRADER_SYMBOL_SIZE_MULT weight first, deepest IBS as the tie-break', () => {
  const prev = process.env.TRADER_SYMBOL_SIZE_MULT;
  process.env.TRADER_SYMBOL_SIZE_MULT = 'SOXL:1.5,SMH:1.5,SPY:0.83,GLD:0.5,TLT:0.5';
  try {
    // SMH (1.5, ibs 0.20) beats SOXL (1.5, ibs 0.28) on depth; SPY 0.83; then GLD/TLT at 0.5 by depth (TLT 0.05 first)
    assert.deepStrictEqual(names(at._orderEntries(SCAN, 'expectancy')), ['SMH', 'SOXL', 'SPY', 'TLT', 'GLD']);
  } finally { if (prev === undefined) delete process.env.TRADER_SYMBOL_SIZE_MULT; else process.env.TRADER_SYMBOL_SIZE_MULT = prev; }
});

test('expectancy with no tilt configured degrades to depth order', () => {
  const prev = process.env.TRADER_SYMBOL_SIZE_MULT;
  delete process.env.TRADER_SYMBOL_SIZE_MULT;
  try {
    assert.deepStrictEqual(names(at._orderEntries(SCAN, 'expectancy')), ['TLT', 'SPY', 'SMH', 'SOXL', 'GLD']);
  } finally { if (prev !== undefined) process.env.TRADER_SYMBOL_SIZE_MULT = prev; }
});
