'use strict';

/**
 * engine-observability.test.js — the two gaps that made 2026-07-29/30 unreadable.
 *
 * 1. A silent tick is indistinguishable from a dead scheduler. The overnight
 *    engine must log SOMETHING every day it runs, and the entry window must
 *    always record its verdict (2026-07-30: the window produced no row at all,
 *    so "correctly declined" and "never ran" looked the same).
 * 2. An exit that fails for a structural reason must stop re-deciding
 *    (2026-07-30: 39 identical error rows over 5.5h on a 0.8-share remnant).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'overnight-trader.js'), 'utf8');
const AT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');

test('overnight: a disabled / bridge-less tick still records a heartbeat', () => {
  assert.match(OT, /_heartbeat\(!c\.enabled \? 'disabled' : 'no_bridge'\)/,
    'the early return must log why it did nothing');
  assert.match(OT, /_heartbeat\('alive'\)/, 'a live tick records that it ran');
});

test('overnight: heartbeats are deduped so the ledger stays one row per day', () => {
  assert.match(OT, /function _appendOnce/, 'dedupe helper exists');
  assert.match(OT, /_appendOnce\('hb_' \+ today/, 'heartbeat keyed by ET date');
});

test('overnight: the entry window logs a verdict even when it enters nothing', () => {
  assert.match(OT, /phase: 'window'/, 'window verdict row exists');
  assert.match(OT, /already entered today/, 'already-entered case is recorded');
  assert.match(OT, /still holding a prior night/, 'still-holding case is recorded');
});

test('overnight: the no-signal skip explains itself', () => {
  assert.match(OT, /no sleeve gate passed — no symbol met an uptrend\/capitulation\/fade condition/);
});

test('auto-trader: repeated terminal exit failures freeze the symbol', () => {
  assert.match(AT, /const MAX_EXIT_FAILURES = 3/, 'a failure ceiling exists');
  assert.match(AT, /_exitFailures\.set\(sym, n\)/, 'consecutive failures are counted');
  assert.match(AT, /workingSells\.add\(sym\);\s*\/\/ stop both exit paths re-deciding/,
    'a frozen symbol is excluded from BOTH exit paths');
});

test('auto-trader: the freeze is logged exactly once, not per attempt', () => {
  assert.match(AT, /if \(!_unclosable\.has\(sym\)\)/, 'guarded so it logs once');
  assert.match(AT, /event: 'exit_frozen'/, 'the freeze is an explicit ledger event');
});

test('auto-trader: the freeze releases when the position leaves the book', () => {
  assert.match(AT, /_exitFailures\.delete\(sym\); _unclosable\.delete\(sym\);/,
    'a future re-entry must start clean');
});
