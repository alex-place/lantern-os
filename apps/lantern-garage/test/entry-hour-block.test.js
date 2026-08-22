'use strict';
/**
 * entry-hour-block.test.js — TRADER_ENTRY_BLOCK_ET (#3427 overnight-leg lab):
 * ET windows during which NEW entries are skipped. Pure helper, default off.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ehb-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

test('unset / empty spec blocks nothing', () => {
  assert.strictEqual(at._entryHourBlocked(14 * 60, undefined), null);
  assert.strictEqual(at._entryHourBlocked(14 * 60, ''), null);
});

test('the validated window: 13:30-14:30 blocks 13:30 and 14:29, not 13:29 or 14:30 (half-open)', () => {
  const spec = '13:30-14:30';
  assert.ok(at._entryHourBlocked(13 * 60 + 30, spec), '13:30 blocked');
  assert.ok(at._entryHourBlocked(14 * 60 + 29, spec), '14:29 blocked');
  assert.strictEqual(at._entryHourBlocked(13 * 60 + 29, spec), null, '13:29 open');
  assert.strictEqual(at._entryHourBlocked(14 * 60 + 30, spec), null, '14:30 open');
  assert.strictEqual(at._entryHourBlocked(14 * 60 + 29, spec).label, '13:30-14:30');
});

test('multiple windows and malformed entries', () => {
  const spec = '09:30-10:30, 12:30-13:30,junk,15:00-14:00';
  assert.deepStrictEqual(at._parseEtWindows(spec).map((w) => w.label), ['09:30-10:30', '12:30-13:30'], 'junk and inverted windows dropped');
  assert.ok(at._entryHourBlocked(9 * 60 + 45, spec));
  assert.ok(at._entryHourBlocked(13 * 60, spec));
  assert.strictEqual(at._entryHourBlocked(11 * 60, spec), null);
  assert.strictEqual(at._entryHourBlocked(15 * 60 + 30, spec), null, 'the last hour is never blocked by this spec');
});
