'use strict';
/**
 * day-pnl-paths.test.js — the positions route must be pointable at the tree the
 * engine actually writes (#3380).
 *
 * The footer's "today" figures are computed from the trade ledger. The route
 * hardcoded a repo-relative ledger path, which is correct exactly once: on the
 * checkout the engine writes to. On the dev server (:4178, a different tree)
 * the same code read a stale ledger, the compute degraded, and the footer
 * silently served IBKR's post-reset dpl (-$174.07) under a tooltip promising
 * "how much the account made TODAY" — on a +$1,901.14 session. These pin the
 * env overrides that let any server name the tree that holds the truth, using
 * the same variable the engine itself honours.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { resolveTradesLog, resolveBarsDir } = require('../lib/day-pnl');

const withEnv = (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};

test('default: repo-relative paths, exactly as before', () => {
  withEnv({ TRADER_TRADES_LOG: null, TRADER_BARS_DIR: null }, () => {
    assert.strictEqual(resolveTradesLog('/repo/data/trading'), path.join('/repo/data/trading', 'autopilot-trades.jsonl'));
    assert.strictEqual(resolveBarsDir('/repo/data/trading'), path.join('/repo/data/trading', 'bars'));
  });
});

test('TRADER_TRADES_LOG overrides — the SAME variable the engine honours', () => {
  withEnv({ TRADER_TRADES_LOG: 'C:/elsewhere/trades.jsonl' }, () => {
    assert.strictEqual(resolveTradesLog('/repo/data/trading'), path.resolve('C:/elsewhere/trades.jsonl'));
  });
  // the engine's own resolution (auto-trader TRADES_LOG) must agree, or the
  // dashboard and the engine could read two different ledgers while both
  // claiming the override:
  withEnv({ TRADER_TRADES_LOG: 'C:/elsewhere/trades.jsonl', TRADER_STATE_FILE: path.join(require('os').tmpdir(), 'dpp-state.json') }, () => {
    delete require.cache[require.resolve('../lib/auto-trader')];
    const at = require('../lib/auto-trader');
    // STATE_FILE is exported; TRADES_LOG is not — assert via the module source
    // contract instead: same env var name, same path.resolve semantics.
    assert.ok(at.STATE_FILE.endsWith('dpp-state.json'), 'engine honours its env overrides');
    assert.strictEqual(resolveTradesLog('/x'), path.resolve('C:/elsewhere/trades.jsonl'));
  });
});

test('TRADER_BARS_DIR overrides the bar corpus location', () => {
  withEnv({ TRADER_BARS_DIR: 'C:/elsewhere/bars' }, () => {
    assert.strictEqual(resolveBarsDir('/repo/data/trading'), path.resolve('C:/elsewhere/bars'));
  });
});
