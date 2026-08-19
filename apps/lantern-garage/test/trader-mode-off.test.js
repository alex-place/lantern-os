'use strict';

/**
 * trader-mode-off.test.js — the per-user autopilot kill-switch (#3212).
 *
 * Contract: connecting a broker must NEVER silently start an autonomous trader
 * on a real user's account. A signed-in user defaults to OFF and flips it on
 * themselves; the operator's single-user box keeps its historical 'stock'
 * default (there, connecting credentials IS the opt-in). 'off' means fully
 * hands-off: no entries, no exits, no account-lock contention.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TRADER_MODE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-mode-test-'));
const mode = require('../lib/trader-mode');

test("'off' is a valid mode", () => {
  assert.ok(mode.VALID.has('off'));
});

test('a REAL signed-in user with no stored choice defaults to OFF', () => {
  assert.strictEqual(mode.get('profile-abc123'), 'off',
    'connecting a broker must not silently start the autopilot');
  assert.strictEqual(mode.defaultFor('profile-abc123'), 'off');
});

test("the operator identities keep the historical 'stock' default", () => {
  assert.strictEqual(mode.get('local-owner'), 'stock');
  assert.strictEqual(mode.get(null), 'stock');
  assert.strictEqual(mode.defaultFor('local-owner'), 'stock');
});

test('a user can turn the trader ON, switch strategy, and turn it OFF again', () => {
  const uid = 'profile-turnon';
  assert.strictEqual(mode.set(uid, 'stock'), true);
  assert.strictEqual(mode.get(uid), 'stock');
  assert.strictEqual(mode.set(uid, 'champion'), true);
  assert.strictEqual(mode.get(uid), 'champion');
  assert.strictEqual(mode.set(uid, 'off'), true);
  assert.strictEqual(mode.get(uid), 'off');
});

test('an invalid mode is refused and the stored choice survives', () => {
  const uid = 'profile-invalid';
  mode.set(uid, 'champion');
  assert.strictEqual(mode.set(uid, 'yolo'), false);
  assert.strictEqual(mode.set(uid, ''), false);
  assert.strictEqual(mode.get(uid), 'champion');
});

test('a corrupt stored value falls back to the SAFE default for that identity', () => {
  const uid = 'profile-corrupt';
  fs.writeFileSync(path.join(process.env.TRADER_MODE_DIR, encodeURIComponent(uid) + '.json'),
    JSON.stringify({ mode: 'not-a-mode' }));
  assert.strictEqual(mode.get(uid), 'off', 'garbage on disk must not turn the trader on');
});

// Mirrors the loop guard in routes/trading.js: an 'off' user is skipped before
// any lock contention — the autopilot must not even contend for their account.
const loopActsOn = (userMode) => userMode !== 'off';

test("the autopilot loop skips an 'off' user entirely", () => {
  assert.strictEqual(loopActsOn('off'), false);
  assert.strictEqual(loopActsOn('stock'), true);
  assert.strictEqual(loopActsOn('champion'), true);
});

test('the default posture for a fresh signed-in user is: loop does not act', () => {
  assert.strictEqual(loopActsOn(mode.get('brand-new-user')), false);
});
