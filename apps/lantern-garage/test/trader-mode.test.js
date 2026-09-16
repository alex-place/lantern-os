'use strict';

/**
 * trader-mode.js — per-user active-trader store: the base contract.
 *
 * Three modes, not two. #3212 added 'off' (the autopilot kill-switch) and, with it, a
 * split default: a REAL signed-in user who never chose defaults to 'off', while the
 * operator identities — anonymous and 'local-owner' — keep the historical 'stock'.
 * This file kept asserting the old two-mode world and had been red ever since, which
 * is worse than no test: three permanent failures are where a real regression hides.
 *
 * Division of labour: trader-mode-off.test.js owns the kill-switch semantics (the safe
 * default, the corrupt-value fallback, what the autopilot loop does with each mode).
 * This file owns the store itself — round-tripping, validation, and the anonymous
 * caller, which is the one case the other file does not cover.
 *
 * Run: node --test apps/lantern-garage/test/trader-mode.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-mode-'));
process.env.TRADER_MODE_DIR = DIR;
const tm = require('../lib/trader-mode');

test('an unset REAL user defaults to off; the operator identities default to stock', () => {
  // Connecting a broker must not silently start an autonomous trader on someone's
  // account (#3212). The single-user box the trader ships in is the exception.
  assert.strictEqual(tm.get('user-a'), 'off');
  assert.strictEqual(tm.get('local-owner'), 'stock');
  assert.strictEqual(tm.DEFAULT, 'stock');
});

test('set + get round-trips every valid mode', () => {
  for (const m of ['champion', 'stock', 'off']) {
    assert.strictEqual(tm.set('user-a', m), true, 'could not set ' + m);
    assert.strictEqual(tm.get('user-a'), m);
  }
});

test('rejects an invalid mode (and does not persist it)', () => {
  assert.strictEqual(tm.set('user-b', 'crypto'), false);
  assert.strictEqual(tm.get('user-b'), 'off', 'a refused write must leave the safe default');
  assert.strictEqual(fs.existsSync(path.join(DIR, 'user-b.json')), false, 'it wrote a file anyway');
});

test('anonymous (null userId) is always the default and cannot be set', () => {
  // The one case trader-mode-off does not cover: there is no identity to store against,
  // so the write is refused rather than landing in some shared file.
  assert.strictEqual(tm.get(null), 'stock');
  assert.strictEqual(tm.set(null, 'champion'), false);
  assert.strictEqual(tm.get(null), 'stock');
});

test('VALID exposes exactly the three modes', () => {
  assert.deepStrictEqual([...tm.VALID].sort(), ['champion', 'off', 'stock']);
});

test('defaultFor is what get() falls back to, for every identity shape', () => {
  for (const id of [null, '', 'local-owner']) assert.strictEqual(tm.defaultFor(id), 'stock', String(id));
  for (const id of ['profile-abc', 'user-a']) assert.strictEqual(tm.defaultFor(id), 'off', id);
});
