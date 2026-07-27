'use strict';

/**
 * overnight-options-tier.test.js — the options trader folded into the overnight book
 * as its 4th EXECUTION tier (operator 2026-07-27).
 *
 * What must hold:
 *   1. 'options' is a valid OVERNIGHT_EXEC tier (and junk still falls back to 1x).
 *   2. ONE signal: options-shadow's gates() delegates its pass/fail to the overnight
 *      book's uptrendGate — the two can never diverge again (they were byte-for-byte
 *      duplicates before the merge).
 *   3. options-shadow exposes the execution-adapter surface the book calls.
 *   4. No double exposure: with the book owning options execution, the shadow's own
 *      LADDER stands down (the penny sleeve, a different holding period, does not).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OT = path.join(__dirname, '..', 'lib', 'overnight-trader.js');
const OX = path.join(__dirname, '..', 'lib', 'options-shadow.js');

function freshOvernight(env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete require.cache[require.resolve(OT)];
  const m = require(OT);
  const cfg = m.cfg();
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return { m, cfg };
}

test("'options' is a valid exec tier; junk falls back to 1x", () => {
  assert.strictEqual(freshOvernight({ OVERNIGHT_EXEC: 'options' }).cfg.exec, 'options');
  assert.strictEqual(freshOvernight({ OVERNIGHT_EXEC: '3x' }).cfg.exec, '3x');
  assert.strictEqual(freshOvernight({ OVERNIGHT_EXEC: 'wat' }).cfg.exec, '1x');
});

test('options tier carries a call ladder + per-leg contract qty', () => {
  const { cfg } = freshOvernight({ OVERNIGHT_EXEC: 'options' });
  assert.ok(Array.isArray(cfg.optionLadder) && cfg.optionLadder.length >= 3, 'ladder present');
  assert.ok(cfg.optionLadder.every((d) => d > 0), 'depths are positive % OTM');
  assert.ok(cfg.optionQty >= 1 && cfg.optionQty <= 10, 'qty clamped to a sane paper size');
});

test('ONE signal: options gates() delegates pass/fail to uptrendGate', () => {
  const ot = require(OT);
  const ox = require(OX);
  // Deterministic synthetic series: a clean uptrend and a clean downtrend.
  const up = []; for (let i = 0; i < 200; i++) up.push(100 + i * 0.5 + Math.sin(i) * 0.8);
  const dn = []; for (let i = 0; i < 200; i++) dn.push(200 - i * 0.5 + Math.sin(i) * 0.8);
  for (const [label, series] of [['uptrend', up], ['downtrend', dn]]) {
    const g = ox.gates(series, { volMode: 'any' });
    const u = ot.uptrendGate(series, 'any');
    assert.strictEqual(g.eligible, u.pass, `${label}: options gate must agree with the book's gate`);
  }
  // The delegation is real, not coincidence: a refusal carries the book's own reason.
  const g = ox.gates(dn, { volMode: 'any' });
  assert.strictEqual(g.delegated, true, 'refusal came from the delegated gate');
  assert.strictEqual(g.why, ot.uptrendGate(dn, 'any').why, 'same refusal reason, verbatim');
});

test('options-shadow exposes the execution-adapter surface the book calls', () => {
  const ox = require(OX);
  for (const fn of ['listNextExpiryCalls', 'quoteOption', 'placePaperOrder', 'pickStrike']) {
    assert.strictEqual(typeof ox[fn], 'function', `${fn} must be exported for the options exec tier`);
  }
});

test('no double exposure: the shadow ladder stands down when the book owns options', () => {
  const src = fs.readFileSync(OX, 'utf8');
  assert.match(src, /_overnightOwnsLadder/, 'ladder stand-down guard present');
  assert.match(src, /OVERNIGHT_EXEC[^\n]*options/, 'guard keys off the options exec tier');
  // The penny sleeve must survive the stand-down — different holding period.
  assert.match(src, /_pennyOnly/, 'penny-only night still opens state');
});

test('the paper options bridge refuses a live auth', () => {
  const src = fs.readFileSync(OX, 'utf8');
  assert.match(src, /paper-only|refused: live auth/i, 'live-auth refusal present in the order path');
});

test('options tier REFUSES a symbol with no next-session expiry', () => {
  // The measured trade is close -> next open. Substituting a monthly (SH's nearest
  // expiry was +24d when this was written) would be a different instrument entirely
  // -- multi-week theta/vega held for one night -- and would silently corrupt the
  // sleeve's expectancy. The guard must refuse, with the real reason.
  const src = fs.readFileSync(OT, 'utf8');
  assert.match(src, /nextSession/, 'next-session expiry check present');
  assert.match(src, /no next-session expiry/, 'refusal carries an explicit reason');
  // The check compares the chain's expiry against the next TRADING day (ET), not a
  // naive +1 calendar day.
  assert.match(src, /nextTradingDayET/, 'uses the ET trading-calendar helper');
});
