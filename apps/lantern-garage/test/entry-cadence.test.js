'use strict';
/**
 * entry-cadence.test.js — TRADER_ENTRY_CADENCE_MIN (#3435 cadence lab): new
 * entries are decided only in the first minutes after a bar boundary, the way
 * every validating lab read the signal (bar closes), instead of at the first
 * 60s scan where the session IBS pokes through the threshold. Pure helper,
 * default off; exits, floors, trails and the broker stop are untouched.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ecad-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');
const M = (h, m) => h * 60 + m;

test('unset / zero / junk cadence blocks nothing', () => {
  assert.strictEqual(at._entryCadenceBlocked(M(10, 17), undefined), null);
  assert.strictEqual(at._entryCadenceBlocked(M(10, 17), 0), null);
  assert.strictEqual(at._entryCadenceBlocked(M(10, 17), 'abc'), null);
  assert.strictEqual(at._entryCadenceBlocked(-1, 60), null, 'no ET minute → no verdict');
});

test('hourly cadence at :00 with a 3-minute window: 10:00-10:02 decide, 10:03-10:59 wait for 11:00', () => {
  assert.strictEqual(at._entryCadenceBlocked(M(10, 0), 60), null, '10:00 is a decision minute');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 2), 60), null, '10:02 still inside the window');
  const b = at._entryCadenceBlocked(M(10, 3), 60);
  assert.ok(b, '10:03 is between closes');
  assert.strictEqual(b.label, '11:00');
  assert.strictEqual(b.since, 3);
  assert.strictEqual(at._entryCadenceBlocked(M(10, 59), 60).label, '11:00');
  assert.strictEqual(at._entryCadenceBlocked(M(15, 30), 60).label, '16:00');
});

test('phase shifts the boundary (30 = the labs\' :30 hourly closes) and window widens the decision span', () => {
  assert.ok(at._entryCadenceBlocked(M(10, 0), 60, 30), '10:00 is between :30 closes');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 30), 60, 30), null, '10:30 decides');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 29), 60, 30).label, '10:30');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 5), 60, 0, 6), null, 'window 6: 10:05 still decides');
  assert.ok(at._entryCadenceBlocked(M(10, 6), 60, 0, 6), 'window 6: 10:06 waits');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 0), 60, 0, 0), null, 'window floors at 1 minute');
});

test('30-minute cadence is the union of the :00 and :30 phases', () => {
  for (const m of [M(10, 0), M(10, 30), M(11, 0), M(15, 30)]) assert.strictEqual(at._entryCadenceBlocked(m, 30), null, `${m} decides`);
  assert.strictEqual(at._entryCadenceBlocked(M(10, 15), 30).label, '10:30');
  assert.strictEqual(at._entryCadenceBlocked(M(10, 45), 30).label, '11:00');
});

test('string env values parse the same way the engine passes them', () => {
  assert.strictEqual(at._entryCadenceBlocked(M(11, 1), '60', '0', '3'), null);
  assert.strictEqual(at._entryCadenceBlocked(M(11, 4), '60', '0', '3').label, '12:00');
  assert.strictEqual(at._entryCadenceBlocked(M(11, 31), '60', '30', undefined), null);
});
