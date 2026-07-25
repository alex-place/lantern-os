'use strict';

/**
 * trader-mode.js — per-user active-trader store (Phase 2 of the Alpaca-first work).
 * Mirrors the broker-preference store: default 'stock', validates the value, and
 * anonymous (null) callers always get the default.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-mode-'));
process.env.TRADER_MODE_DIR = DIR;
const tm = require('../lib/trader-mode');

test('defaults to stock for an unset user', () => {
  assert.strictEqual(tm.get('user-a'), 'stock');
});

test('set + get round-trips a valid mode', () => {
  assert.strictEqual(tm.set('user-a', 'champion'), true);
  assert.strictEqual(tm.get('user-a'), 'champion');
  assert.strictEqual(tm.set('user-a', 'stock'), true);
  assert.strictEqual(tm.get('user-a'), 'stock');
});

test('rejects an invalid mode (and does not persist it)', () => {
  assert.strictEqual(tm.set('user-b', 'crypto'), false);
  assert.strictEqual(tm.get('user-b'), 'stock');   // unchanged default
});

test('anonymous (null userId) is always the default and cannot be set', () => {
  assert.strictEqual(tm.get(null), 'stock');
  assert.strictEqual(tm.set(null, 'champion'), false);
});

test('VALID exposes exactly the two modes', () => {
  assert.deepStrictEqual([...tm.VALID].sort(), ['champion', 'stock']);
});
