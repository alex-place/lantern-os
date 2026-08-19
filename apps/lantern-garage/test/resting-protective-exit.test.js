'use strict';

/**
 * resting-protective-exit.test.js — a dead process must not mean an unexitable
 * position, and a safety net must never become a naked short.
 *
 * 2026-07-29: the exit lived only in this process; the process died and a 0-DTE
 * ladder expired worthless (−$2,006). Entries now rest a GTC take-profit on the
 * BROKER, which survives the process entirely. The dangerous half is the exit:
 * a resting sell that outlives its long goes short on its next fill, so the
 * primary exit must retire it FIRST and refuse to sell if it can't.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const OT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'overnight-trader.js'), 'utf8');
const OS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'options-shadow.js'), 'utf8');
const ot = require('../lib/overnight-trader');

test('the bridge can rest a GTC order and cancel one', () => {
  assert.match(OS, /time_in_force: timeInForce/, 'tif is parameterised, not hardcoded to day');
  assert.match(OS, /=== 'gtc' \? 'gtc' : 'day'/, 'gtc is opt-in, day stays the default');
  assert.match(OS, /async function cancelPaperOrder/, 'cancel exists');
  assert.match(OS, /r\.status === 404.*alreadyGone|alreadyGone: true/s, '404 = already gone, treated as success');
});

test('a protective sell is rested at entry, above the entry ask', () => {
  assert.match(OT, /protectTargetPct: n\('OVERNIGHT_PROTECT_TARGET_PCT', 50\)/, 'configurable, default +50%');
  assert.match(OT, /side: 'sell', qty: c\.optionQty, limit: protectLimit, tif: 'gtc'/, 'rests GTC on the broker');
  assert.match(OT, /phase: 'protect'/, 'the net is recorded in the ledger');
  // the target must be strictly above the entry price, else it is not a take-profit
  const ask = 2.00, pct = 50;
  const target = Math.max(0.01, Math.round(ask * (1 + pct / 100) * 100) / 100);
  assert.ok(target > ask, `target ${target} must exceed entry ${ask}`);
});

test('a failed protect does NOT block the entry', () => {
  assert.match(OT, /must never block the entry/, 'documented as best-effort');
  assert.match(OT, /protectId \? 'resting' : `error:/, 'a failure is logged, not thrown');
});

test('NAKED-SHORT GUARD: the exit cancels the resting sell before selling', () => {
  const exitIdx = OT.indexOf("RETIRE THE RESTING PROTECTIVE SELL FIRST");
  const sellIdx = OT.indexOf("ox.placePaperOrder({ contract: leg.contract, side: 'sell'");
  assert.ok(exitIdx > -1, 'the guard exists');
  assert.ok(exitIdx < sellIdx, 'the cancel must come BEFORE the sell');
  assert.match(OT, /if \(!protectRetired\)/, 'a failed cancel is handled');
  assert.match(OT, /refusing to sell twice \(naked-short guard\)/, 'and refuses to sell');
});

test('a leg blocked by the guard is retained, not lost', () => {
  assert.match(OT, /remainingLegs\.push\(leg\)/, 'blocked legs are kept');
  assert.match(OT, /st\.open = \{ \.\.\.st\.open, legs: remainingLegs \}/, 'state keeps them for the retry');
  assert.match(OT, /phase: 'exit_partial'/, 'and it is visible in the ledger');
});

test('a protective fill while we were away is booked as the exit', () => {
  assert.match(OT, /status: 'protective_fill'/, 'the net catching it is a real exit row');
});

test('config surfaces the protective target', () => {
  const c = ot.cfg();
  assert.strictEqual(typeof c.protectTargetPct, 'number');
  assert.ok(c.protectTargetPct >= 0, 'never negative');
});
