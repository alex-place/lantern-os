'use strict';

/**
 * convergence-store-isolation.test.js — tests must never write into the live
 * convergence memory.
 *
 * When the stock autopilot began emitting a record per entry/exit (#3286), the
 * record store's path was resolved from __dirname with no override. logTrade
 * calls the emitter, so EVERY test that drove runAutoTrade wrote its fixtures
 * into production. One test run on 2026-08-14 put 51 invented trades into
 * data/convergence/records.jsonl — "GLD long 19 @ 100.00", "NVDA @ 180.00",
 * "X @ 100.00" — none distinguishable downstream from a real trade.
 *
 * That is the worst failure mode for a learning store: not empty, but quietly
 * seeded with things that never happened. The whole point of #3286 is to make
 * the trader's own history usable, and invented rows make it unusable while
 * looking fine.
 *
 * Two independent defences, both pinned here:
 *   1. CONVERGENCE_RECORDS_FILE redirects the store.
 *   2. A redirected TRADER_TRADES_LOG without a redirected store means "test
 *      rig" — emit nothing rather than trust every future test to remember.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-iso-'));

function freshRequire(env) {
  for (const k of Object.keys(require.cache)) {
    if (/convergence-records|trader-convergence|file-queue/.test(k)) delete require.cache[k];
  }
  const saved = {
    TRADER_TRADES_LOG: process.env.TRADER_TRADES_LOG,
    CONVERGENCE_RECORDS_FILE: process.env.CONVERGENCE_RECORDS_FILE,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const tc = require('../lib/trader-convergence');
  const cr = require('../lib/convergence-records');
  return { tc, cr, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

const ENTRY = { symbol: 'GLD', qty: 19, entry: 100, target1: 0, stop: 97, tier: 'A', p_win: 0.7 };

test('CONVERGENCE_RECORDS_FILE redirects the store away from production', () => {
  const target = path.join(dir, 'redirected.jsonl');
  const { cr, restore } = freshRequire({ CONVERGENCE_RECORDS_FILE: target });
  try {
    assert.strictEqual(cr.RECORDS_PATH, path.resolve(target));
    assert.doesNotMatch(cr.RECORDS_PATH, /data[\\/]convergence[\\/]records\.jsonl$/);
  } finally { restore(); }
});

test('without the override the store resolves to the real repo path', () => {
  const { cr, restore } = freshRequire({ CONVERGENCE_RECORDS_FILE: undefined });
  try {
    assert.match(cr.RECORDS_PATH, /data[\\/]convergence[\\/]records\.jsonl$/);
  } finally { restore(); }
});

test('THE BUG: a redirected ledger with a live store emits NOTHING', async () => {
  const { tc, restore } = freshRequire({
    TRADER_TRADES_LOG: path.join(dir, 'trades.jsonl'),
    CONVERGENCE_RECORDS_FILE: undefined,
  });
  try {
    assert.strictEqual(await tc.recordEntryHypothesis(ENTRY), null,
      'a test rig must not reach the live convergence store');
    assert.strictEqual(await tc.recordExitOutcome({
      symbol: 'GLD', qty: 19, entry: 100, exit: 101, pnl: 19, reason: 'signal_exit', status: 'filled', order_id: 'x',
    }), null);
  } finally { restore(); }
});

test('redirect BOTH and records are written normally', async () => {
  const target = path.join(dir, 'both.jsonl');
  const { tc, restore } = freshRequire({
    TRADER_TRADES_LOG: path.join(dir, 'trades.jsonl'),
    CONVERGENCE_RECORDS_FILE: target,
  });
  try {
    const rec = await tc.recordEntryHypothesis(ENTRY);
    assert.ok(rec && rec.id, 'a properly isolated test still exercises the real emitter');
    await new Promise((r) => setTimeout(r, 60));   // the append queue is async
    assert.ok(fs.existsSync(target), 'written to the redirected store');
  } finally { restore(); }
});

test('production (no ledger redirect) is unaffected — real trades still record', async () => {
  const target = path.join(dir, 'prod-like.jsonl');
  const { tc, restore } = freshRequire({
    TRADER_TRADES_LOG: undefined,          // the live engine does not set this
    CONVERGENCE_RECORDS_FILE: target,      // redirected only so the test is safe
  });
  try {
    const rec = await tc.recordEntryHypothesis(ENTRY);
    assert.ok(rec && rec.id, 'the guard must not suppress genuine emission');
  } finally { restore(); }
});

test('a claim with no target1 states something gradeable, not "target1 0.00"', async () => {
  const target = path.join(dir, 'text.jsonl');
  const { tc, restore } = freshRequire({ CONVERGENCE_RECORDS_FILE: target });
  try {
    const rec = await tc.recordEntryHypothesis(ENTRY);   // target1: 0
    assert.doesNotMatch(rec.hypothesis, /target1 0\.00/, 'an unreachable "0.00" target is not a hypothesis');
    assert.match(rec.hypothesis, /closes profitably \(no target1 set\)/);
    const withT1 = await tc.recordEntryHypothesis({ ...ENTRY, target1: 105 });
    assert.match(withT1.hypothesis, /reaches target1 105\.00 \(\+5\.0%\)/);
  } finally { restore(); }
});

test('a missing stop is stated, not printed as 0.00', async () => {
  const target = path.join(dir, 'nostop.jsonl');
  const { tc, restore } = freshRequire({ CONVERGENCE_RECORDS_FILE: target });
  try {
    const rec = await tc.recordEntryHypothesis({ ...ENTRY, stop: 0, target1: 105 });
    assert.doesNotMatch(rec.hypothesis, /stop 0\.00/);
    assert.match(rec.hypothesis, /no protective stop recorded/);
  } finally { restore(); }
});
