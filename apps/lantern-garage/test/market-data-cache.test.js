'use strict';
/**
 * market-data-cache.test.js — the market-data cache frees what it can no longer serve (2026-09-28).
 *
 * The cache never deleted an entry. Two of its keys name a LIST of tickers, and the
 * auto-trader asks for the bars of its ENTER candidates on every scan, so every change in
 * that list left about 7 MB behind for good. Live 2026-09-28 the two-sleeve runner stood
 * at 3,882 MB after 503 ticks against a 4,144 MB heap limit.
 *
 * These pin: an entry inside its TTL is served as before; an expired entry is dropped by
 * the sweep and not only hidden; a stream of distinct list keys stays bounded; a long-lived
 * entry survives the sweeps a short-lived one does not; the hard cap drops the oldest first;
 * re-writing a key refreshes it; and every write in the module names a TTL.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yahoo = require('../lib/market-data-yahoo');
const C = yahoo._cache;

const realNow = Date.now;
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };
const T0 = 1_790_000_000_000;

test('an entry inside its TTL is served; past it, it is not', () => {
  C.clear();
  at(T0, () => C.set('b:SPY:5m', { bars: [1] }, 45000));
  assert.deepStrictEqual(at(T0 + 44000, () => C.get('b:SPY:5m', 45000)), { bars: [1] });
  assert.strictEqual(at(T0 + 45000, () => C.get('b:SPY:5m', 45000)), null);
});

test('an expired entry is FREED by the next sweep, not only hidden', () => {
  C.clear();
  at(T0, () => C.set('bm:5m:SPY,QQQ', { bars: {} }, 45000));
  assert.strictEqual(C.size(), 1);
  // a write one minute later, under another key: the sweep runs and the first entry goes
  at(T0 + 60000, () => C.set('bm:5m:SPY,IWM', { bars: {} }, 45000));
  assert.deepStrictEqual(C.keys(), ['bm:5m:SPY,IWM']);
});

test('the leak: a new candidate list on every scan stays bounded', () => {
  C.clear();
  const names = 'SPY QQQ IWM DIA GLD TLT SMH XLK SOXL TNA SPXL TQQQ UPRO USO XOP GDX SLV XLE NUGT JNUG UCO'.split(' ');
  let peak = 0;
  for (let tick = 0; tick < 600; tick++) {           // ten hours of 60-second scans
    const list = names.filter((_, i) => (tick >> (i % 9)) % 2 === 0 || i === tick % names.length);
    at(T0 + tick * 60000, () => C.set('bm:5m:' + list.join(','), { bars: {} }, 45000));
    peak = Math.max(peak, C.size());
  }
  assert.ok(peak <= 2, `at most the live entry and the one being swept, got ${peak}`);
});

test('a long-lived entry survives the sweeps that drop the short-lived ones', () => {
  C.clear();
  at(T0, () => { C.set('earn_NVDA', { surprise: 4.2 }, 6 * 3600 * 1000); C.set('q:SPY,QQQ', [1, 2], 20000); });
  at(T0 + 3600000, () => C.set('b:SPY:5m', { bars: [] }, 45000));
  assert.deepStrictEqual(C.keys().sort(), ['b:SPY:5m', 'earn_NVDA']);
  assert.deepStrictEqual(at(T0 + 3600000, () => C.get('earn_NVDA', 6 * 3600 * 1000)), { surprise: 4.2 });
  at(T0 + 7 * 3600000, () => C.set('b:QQQ:5m', { bars: [] }, 45000));
  assert.deepStrictEqual(C.keys(), ['b:QQQ:5m'], 'six hours on, the earnings entry has expired too');
});

test('a burst of distinct keys inside one sweep interval meets the hard cap, oldest first', () => {
  C.clear();
  at(T0, () => { for (let i = 0; i < C.MAX + 50; i++) C.set('bw:SYM' + i + ':5m:1:2', { bars: [] }, 6 * 3600 * 1000); });
  assert.strictEqual(C.size(), C.MAX);
  const keys = C.keys();
  assert.strictEqual(keys[0], 'bw:SYM50:5m:1:2', 'the first fifty written were the first dropped');
  assert.strictEqual(keys[keys.length - 1], 'bw:SYM' + (C.MAX + 49) + ':5m:1:2');
});

test('re-writing a key refreshes its age and its place in the order', () => {
  C.clear();
  at(T0, () => { C.set('b:SPY:5m', 1, 45000); C.set('b:QQQ:5m', 1, 45000); });
  at(T0 + 40000, () => C.set('b:SPY:5m', 2, 45000));
  assert.deepStrictEqual(C.keys(), ['b:QQQ:5m', 'b:SPY:5m'], 'the rewritten key moved to the tail');
  at(T0 + 80000, () => C.sweep(Date.now()));
  assert.deepStrictEqual(C.keys(), ['b:SPY:5m'], 'QQQ expired at 45s; SPY was refreshed at 40s and lives until 85s');
  assert.strictEqual(at(T0 + 80000, () => C.get('b:SPY:5m', 45000)), 2);
});

test('a write without a usable TTL takes the short chart life instead of living for ever', () => {
  C.clear();
  at(T0, () => { C.set('x', 1); C.set('y', 1, 0); C.set('z', 1, -5); });
  at(T0 + 46000, () => C.sweep(Date.now()));
  assert.strictEqual(C.size(), 0);
});

test('every cache write in the module names its TTL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'market-data-yahoo.js'), 'utf8');
  const calls = src.split(/\r?\n/).filter((l) => /^\s+(if \(gotData\) )?cacheSet\(/.test(l));
  assert.ok(calls.length >= 7, `expected the seven call sites, found ${calls.length}`);
  for (const l of calls) assert.ok(/cacheSet\(key, \w+, [^)]+\)/.test(l), 'no TTL: ' + l.trim());
});

test('kill switch: MARKET_DATA_CACHE_SWEEP=0 frees nothing, as before', () => {
  C.clear();
  const old = process.env.MARKET_DATA_CACHE_SWEEP;
  process.env.MARKET_DATA_CACHE_SWEEP = '0';
  try {
    for (let i = 0; i < 300; i++) at(T0 + i * 60000, () => C.set('bm:5m:L' + i, { bars: {} }, 45000));
    assert.strictEqual(C.size(), 300, 'every entry kept');
  } finally { if (old == null) delete process.env.MARKET_DATA_CACHE_SWEEP; else process.env.MARKET_DATA_CACHE_SWEEP = old; }
  at(T0 + 301 * 60000, () => C.set('bm:5m:after', { bars: {} }, 45000));
  assert.deepStrictEqual(C.keys(), ['bm:5m:after'], 'with the switch back on, the next write sweeps them');
});
