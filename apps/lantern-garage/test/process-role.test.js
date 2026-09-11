'use strict';
/**
 * test/process-role.test.js — #3523.
 *
 * LANTERN_ROLE decides which half of the app a process runs: everything (unset, as the
 * local boxes and the desktop app always have), the website, or the trading loops.
 * Run: node --test apps/lantern-garage/test/process-role.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const pr = require('../lib/process-role');

test('unset means all: the local boxes and the desktop app run everything, as before', () => {
  assert.strictEqual(pr.role({}), 'all');
  assert.strictEqual(pr.role({ LANTERN_ROLE: '' }), 'all');
  assert.deepStrictEqual([pr.runsWeb({}), pr.runsTrader({})], [true, true]);
});

test('web runs the site only; trader runs the trading loops only', () => {
  assert.deepStrictEqual([pr.runsWeb({ LANTERN_ROLE: 'web' }), pr.runsTrader({ LANTERN_ROLE: 'web' })], [true, false]);
  assert.deepStrictEqual([pr.runsWeb({ LANTERN_ROLE: 'trader' }), pr.runsTrader({ LANTERN_ROLE: 'trader' })], [false, true]);
  assert.strictEqual(pr.role({ LANTERN_ROLE: ' Trader ' }), 'trader');
});

test('a typo is an error, never a silent second trader', () => {
  assert.throws(() => pr.role({ LANTERN_ROLE: 'webb' }), /LANTERN_ROLE must be one of all, web, trader/);
});

test("applyRoleEnv turns the web process's trading loops off, and touches nothing else", () => {
  const web = { LANTERN_ROLE: 'web' };
  assert.strictEqual(pr.applyRoleEnv(web), 'web');
  assert.strictEqual(web.TRADER_AUTOSCAN, '0');
  const all = {};
  pr.applyRoleEnv(all);
  assert.strictEqual(all.TRADER_AUTOSCAN, undefined);
  const trader = { LANTERN_ROLE: 'trader', TRADER_AUTOSCAN: '1' };
  pr.applyRoleEnv(trader);
  assert.strictEqual(trader.TRADER_AUTOSCAN, '1');
});

test("traderUrl: the supervisor's URL, else the default loopback port", () => {
  assert.strictEqual(pr.traderUrl({}), 'http://127.0.0.1:4190');
  assert.strictEqual(pr.traderUrl({ LANTERN_TRADER_PORT: '5001' }), 'http://127.0.0.1:5001');
  assert.strictEqual(pr.traderUrl({ LANTERN_TRADER_URL: 'http://127.0.0.1:6000' }), 'http://127.0.0.1:6000');
});
