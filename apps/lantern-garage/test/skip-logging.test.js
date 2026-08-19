'use strict';

/**
 * skip-logging.test.js — the trader must leave a record of WHY it declined.
 *
 * On 2026-08-05 the trader took one trade all session while GLD ran +1.85% and
 * SQQQ +4.75%. out.skipped was memory-only, so the reasons were gone by the time
 * anyone asked, and the post-mortem had to replay bars offline to guess. These
 * tests pin the two properties that make the log useful: it records a blocker
 * once (not once per scan), and it records it AGAIN if it recurs after a gap.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const p = require('path');

const _tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'skiplog-'));
process.env.TRADER_TRADES_LOG = p.join(_tmp, 'trades.jsonl');
process.env.TRADER_STATE_FILE = p.join(_tmp, 'state.json');

const at = require('../lib/auto-trader');

const LOG = process.env.TRADER_TRADES_LOG;
function rows() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function skips() { return rows().filter((r) => r.event === 'skip'); }
function reset() { try { fs.unlinkSync(LOG); } catch (_e) { /* absent */ } at._resetCooldowns(); }

test('a repeated blocker is recorded ONCE, not once per scan', () => {
  reset();
  const skipped = [{ symbol: 'GLD', direction: 'BEARISH', p_win: 0.62, why: 'sup_entry: no support zone below price' }];
  for (let i = 0; i < 50; i++) at._logSkips(skipped);
  assert.strictEqual(skips().length, 1, '50 identical scans must leave one row, not 50');
  assert.strictEqual(skips()[0].symbol, 'GLD');
  assert.match(skips()[0].reason, /sup_entry/);
});

test('counters embedded in the reason do not defeat the dedupe', () => {
  reset();
  // 'min-hold (3<5min)' ticks every scan — without digit-normalisation each
  // tick would look like a brand new blocker and spam a row per scan.
  for (let i = 1; i <= 20; i++) at._logSkips([{ symbol: 'IWM', why: `min-hold (${i}<30min) — stop still protects` }]);
  assert.strictEqual(skips().length, 1, 'a ticking counter is the SAME blocker');
});

test('a DIFFERENT blocker on the same symbol is recorded', () => {
  reset();
  at._logSkips([{ symbol: 'SQQQ', why: 'sup_entry: no support zone below price' }]);
  at._logSkips([{ symbol: 'SQQQ', why: 'direction_conflict: opposite QQQ exposure' }]);
  assert.strictEqual(skips().length, 2, 'the story changed — record it');
});

test('a blocker that returns after the symbol became tradeable is recorded again', () => {
  reset();
  at._logSkips([{ symbol: 'GLD', why: 'sup_entry: no support zone below price' }]);
  at._logSkips([]);                                  // GLD no longer skipped
  at._logSkips([{ symbol: 'GLD', why: 'sup_entry: no support zone below price' }]);
  assert.strictEqual(skips().length, 2, 'a recurrence is a new occurrence, not a duplicate');
});

test('TRADER_LOG_SKIPS=0 disables the log entirely', () => {
  reset();
  const saved = process.env.TRADER_LOG_SKIPS;
  try {
    process.env.TRADER_LOG_SKIPS = '0';
    at._logSkips([{ symbol: 'SPY', why: 'anything' }]);
    assert.strictEqual(skips().length, 0);
  } finally {
    if (saved === undefined) delete process.env.TRADER_LOG_SKIPS; else process.env.TRADER_LOG_SKIPS = saved;
  }
});
