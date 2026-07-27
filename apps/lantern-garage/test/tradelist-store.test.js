'use strict';

/**
 * tradelist-store.js — the AI autopilot's per-user trading universe (split from the
 * tracking-only watchlist). Mirrors watchlist-store; seeds from tradelist.seed.json
 * (the measured ETF basket), never from the user's watchlist.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/tradelist-store');
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'tradelist.seed.json'), 'utf8')).tickers;

// Isolate: point the store's dir at a temp home by using a unique test user and
// cleaning its file after (the store has no dir override; per-user files isolate us).
const U = 'tradelist-test-' + Date.now();
const FILE = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'tradelists', encodeURIComponent(U) + '.json');

test('first access seeds from tradelist.seed.json (the measured ETF basket)', () => {
  const list = store.getTradelist(U);
  assert.deepStrictEqual(list, SEED);
  assert.ok(list.includes('SPY') && list.includes('SQQQ') && list.includes('SOXL'), 'ETF universe present');
  assert.ok(!list.includes('AAPL') && !list.includes('BTCUSD'), 'no single stocks / crypto in the AI default');
});

test('add/remove round-trip, cleaning and dedupe', () => {
  const added = store.addTicker(U, ' xle ');
  assert.ok(added.includes('XLE'));
  assert.deepStrictEqual(store.addTicker(U, 'XLE'), added, 'dedupe: second add is a no-op');
  const removed = store.removeTicker(U, 'xle');
  assert.ok(!removed.includes('XLE'));
});

test('allTickers unions the seed with every user list', () => {
  store.addTicker(U, 'XLF');
  const all = store.allTickers();
  assert.ok(all.includes('XLF'), 'user addition visible to the scan union');
  assert.ok(SEED.every((s) => all.includes(s)), 'seed always present for collector coverage');
});

test('cleanup', () => { try { fs.unlinkSync(FILE); } catch (_e) { /* */ } assert.ok(true); });
