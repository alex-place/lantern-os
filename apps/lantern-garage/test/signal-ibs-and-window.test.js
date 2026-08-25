'use strict';
/**
 * signal-ibs-and-window.test.js — two defects found live on 2026-08-25.
 *
 * (A) THE BOUNCE EXIT WAS BLIND. scan.js puts the session IBS on
 *     `decision_context.ibs` (#3375/#3381 moved the evidence there) and never at
 *     the signal's top level, but the exit gate and the slot-order tie-break both
 *     read `s.ibs`. So `s.ibs` was permanently undefined: the validated IBS bounce
 *     exit (1,494% vs 462% on the 26y holdout, #3437) never fired once, and slot
 *     priority silently degraded to weight-only. Live 8/25: 28 "no session IBS
 *     reading yet" rows across exactly the three held names, while sessionIbs()
 *     computed fine from the same cache (DIA 0.492, SPXL 0.468, SOXL 0.249).
 *
 * (B) THE FIRST FILL TOOK THE WHOLE HOUR. The cadence bar was spent on the first
 *     placement, so whichever symbol resolved first won the window: on 8/25 the
 *     11:00 bar went to DIA (tilt 0.71, lowest-weighted name on the list) and then
 *     blocked QQQ and SMH (tilt 1.5) at 11:01 with three slots free.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigibs-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

// the shape scan.js actually emits — no top-level ibs
const scanSignal = (symbol, ibs, extra = {}) => ({
  symbol, direction: 'BULLISH', entry_price: 100,
  decision_context: { ibs, spy_tape: -0.3 },
  convergence: { decision: 'ENTER', p_win: 0.6 }, ...extra,
});

test('A: _signalIbs reads decision_context.ibs — the real scan shape', () => {
  assert.strictEqual(at._signalIbs(scanSignal('DIA', 0.492)), 0.492);
  assert.strictEqual(at._signalIbs(scanSignal('SOXL', 0.249)), 0.249);
  assert.strictEqual(at._signalIbs({ symbol: 'X', decision_context: { ibs: 0 } }), 0, 'zero is a real reading, not missing');
});

test('A: an explicit top-level ibs still wins if one is ever added', () => {
  assert.strictEqual(at._signalIbs({ ibs: 0.71, decision_context: { ibs: 0.2 } }), 0.71);
});

test('A: a genuinely missing reading is null, so the hold-not-sell guard still fires', () => {
  assert.strictEqual(at._signalIbs({ symbol: 'Y', decision_context: {} }), null);
  assert.strictEqual(at._signalIbs({ symbol: 'Y' }), null);
  assert.strictEqual(at._signalIbs(null), null);
  assert.strictEqual(at._signalIbs({ decision_context: { ibs: 'abc' } }), null);
});

test('A: slot order ranks on depth again — 8/25 11:00 would have gone SMH/QQQ before DIA', () => {
  const prev = process.env.TRADER_SYMBOL_SIZE_MULT;
  process.env.TRADER_SYMBOL_SIZE_MULT = 'SOXL:1.5,SMH:1.5,QQQ:1.5,IWM:1.02,XLK:1.0,SPY:0.83,DIA:0.71';
  try {
    // the live readings at 11:00 on 2026-08-25
    const order = at._orderEntries(
      [scanSignal('DIA', 0.24), scanSignal('QQQ', 0.29), scanSignal('SMH', 0.22), scanSignal('TQQQ', 0.28)],
      'expectancy',
    ).map((s) => s.symbol);
    assert.strictEqual(order[order.length - 1], 'DIA', `DIA (tilt 0.71) must rank last, got ${order.join('>')}`);
    assert.deepStrictEqual(order.slice(0, 2), ['SMH', 'QQQ'], 'the two 1.5-weight names lead, deeper IBS first');
  } finally { if (prev === undefined) delete process.env.TRADER_SYMBOL_SIZE_MULT; else process.env.TRADER_SYMBOL_SIZE_MULT = prev; }
});

test('A: with no tilt configured, depth alone orders the candidates', () => {
  const prev = process.env.TRADER_SYMBOL_SIZE_MULT;
  delete process.env.TRADER_SYMBOL_SIZE_MULT;
  try {
    const order = at._orderEntries([scanSignal('A', 0.30), scanSignal('B', 0.05), scanSignal('C', 0.18)], 'depth').map((s) => s.symbol);
    assert.deepStrictEqual(order, ['B', 'C', 'A']);
  } finally { if (prev !== undefined) process.env.TRADER_SYMBOL_SIZE_MULT = prev; }
});

test('B: a fill INSIDE the decision window leaves the bar open for the rest to compete', () => {
  const M = (h, m) => h * 60 + m;
  const E = process.env;
  const prev = { c: E.TRADER_ENTRY_CADENCE_MIN, p: E.TRADER_ENTRY_CADENCE_PHASE, w: E.TRADER_ENTRY_CADENCE_WINDOW };
  E.TRADER_ENTRY_CADENCE_MIN = '60'; E.TRADER_ENTRY_CADENCE_PHASE = '0'; E.TRADER_ENTRY_CADENCE_WINDOW = '3';
  try {
    // 11:00 boundary, a scan at 11:00 (since=0, inside the 3-min window) that PLACES
    assert.strictEqual(at._entryCadenceBlocked(M(11, 0), 60, 0, 3, null), null, '11:00 decides');
    // after an in-window placement the bar must NOT be marked decided, so 11:01 still decides
    assert.strictEqual(at._entryCadenceBlocked(M(11, 1), 60, 0, 3, null), null, '11:01 is still inside the window');
    // but once the window has passed, a bar already decided is closed
    const blocked = at._entryCadenceBlocked(M(11, 20), 60, 0, 3, M(11, 0));
    assert.ok(blocked && blocked.why === 'decided', 'past the window with the bar spent -> blocked');
    // and an untouched bar still allows one late first scan
    assert.strictEqual(at._entryCadenceBlocked(M(11, 20), 60, 0, 3, null), null, 'late first scan of an unspent bar still decides');
  } finally {
    if (prev.c === undefined) delete E.TRADER_ENTRY_CADENCE_MIN; else E.TRADER_ENTRY_CADENCE_MIN = prev.c;
    if (prev.p === undefined) delete E.TRADER_ENTRY_CADENCE_PHASE; else E.TRADER_ENTRY_CADENCE_PHASE = prev.p;
    if (prev.w === undefined) delete E.TRADER_ENTRY_CADENCE_WINDOW; else E.TRADER_ENTRY_CADENCE_WINDOW = prev.w;
  }
});
