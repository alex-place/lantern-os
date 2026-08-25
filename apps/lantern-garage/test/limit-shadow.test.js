'use strict';
/**
 * limit-shadow.test.js — the journal-only limit shadow (#3424 lab → engine).
 *
 * On every real entry the engine records the resting limits it did NOT place
 * (0.25/0.5/0.75/1.0% under the touch) and marks which ones the mark touches
 * during the touch session. It never places an order and never affects an
 * exit; experiments/limit_shadow_score.js reads the rows.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'limshadow-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
delete process.env.TRADER_LIMIT_SHADOW;

// HERMETIC EXITS (2026-08-25). These fixtures hold a position in "LNG" — a REAL
// ticker — and the engine's market-data-driven exits fetch live bars for whatever
// symbol it is holding. So with those exits at their defaults the suite's verdict
// depends on Cheniere Energy's intraday MACD/RSI: CI was green at 14:49 ET and red
// at 15:58 ET the same afternoon, with be-ratchet losing 6 tests and eod-flat 4 to
// a `momentum_died (MACD hist<0, <EMA9, RSI 40)` exit that closed the position out
// from under the behaviour being tested. Pinning the five exit-authority switches
// to their ARMED production values (#3437/#3438) makes the fixture deterministic
// AND more faithful to the engine that actually runs. A test about the limit shadow book must
// not be able to fail because a real stock moved.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');
const sh = at._limitShadow;
const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { at._resetCooldowns(); if (fs.existsSync(LOG)) fs.unlinkSync(LOG); };
// a fixed instant mid-session (ET), so "same session" ticks stay on one ET date
const T0 = Date.parse('2026-08-24T15:00:00Z');

test('arms on entry with every depth unfilled; nothing journaled yet', () => {
  reset();
  sh.arm('LNG', 100, T0);
  const s = sh.map.get('LNG');
  assert.ok(s, 'armed');
  assert.strictEqual(s.touch, 100);
  assert.deepStrictEqual(Object.values(s.fills), [null, null, null, null]);
  assert.strictEqual(rows().length, 0);
});

test('a mark above every limit fills nothing; a dip to -0.6% fills 0.25% and 0.5% only, at the level', () => {
  reset();
  sh.arm('LNG', 100, T0);
  sh.tick('LNG', 100.4, T0 + 60e3);
  assert.strictEqual(rows().length, 0, 'no fills above the limits');
  sh.tick('LNG', 99.4, T0 + 120e3);
  const fills = rows().filter((r) => r.event === 'limit_shadow_fill');
  assert.deepStrictEqual(fills.map((r) => r.depth), [0.0025, 0.005], 'exactly the two depths the mark crossed');
  assert.deepStrictEqual(fills.map((r) => r.fill_px), [99.75, 99.5], 'filled AT the level, not at the mark');
  assert.strictEqual(fills[0].minutes_after_touch, 2);
  assert.strictEqual(sh.map.get('LNG').fills['0.0075'], null, '0.75% still unfilled');
});

test('a depth fills once — a second dip does not re-journal it; deeper dips add the deeper depths', () => {
  reset();
  sh.arm('LNG', 100, T0);
  sh.tick('LNG', 99.6, T0 + 60e3);
  sh.tick('LNG', 99.6, T0 + 120e3);
  assert.strictEqual(rows().filter((r) => r.event === 'limit_shadow_fill').length, 1, '0.25% journaled once');
  sh.tick('LNG', 98.9, T0 + 180e3);
  const depths = rows().filter((r) => r.event === 'limit_shadow_fill').map((r) => r.depth);
  assert.deepStrictEqual(depths, [0.0025, 0.005, 0.0075, 0.01]);
});

test('the shadow closes with the session (next ET date) and with the position', () => {
  reset();
  sh.arm('LNG', 100, T0);
  sh.tick('LNG', 99.7, T0 + 60e3);
  sh.tick('LNG', 99.0, T0 + 24 * 3600e3);          // next session: closes without filling anything more
  const close = rows().find((r) => r.event === 'limit_shadow_close');
  assert.ok(close, 'close row written');
  assert.strictEqual(close.why, 'session_end');
  assert.strictEqual(close.fills['0.0025'], 99.75);
  assert.strictEqual(close.fills['0.01'], null, 'the next-session dip did not count');
  assert.ok(!sh.map.has('LNG'), 'state cleared');

  sh.arm('LNG', 50, T0);
  sh.close('LNG', 'position_closed');
  assert.strictEqual(rows().filter((r) => r.event === 'limit_shadow_close').length, 2);
  assert.ok(!sh.map.has('LNG'));
});

test('TRADER_LIMIT_SHADOW=0 disables arming; the map survives a save/load round-trip', () => {
  reset();
  process.env.TRADER_LIMIT_SHADOW = '0';
  sh.arm('LNG', 100, T0);
  assert.ok(!sh.map.has('LNG'), 'disabled');
  delete process.env.TRADER_LIMIT_SHADOW;
  sh.arm('LNG', 100, T0);
  at._saveState();
  sh.map.clear();
  at._loadState();
  assert.strictEqual(sh.map.get('LNG').touch, 100, 'restored from state');
});
