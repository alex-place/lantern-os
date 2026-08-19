'use strict';
/**
 * selective-time-weight.test.js — the 11:00 floor becomes a PRICE, not a ban
 * (#3356).
 *
 * As a hard floor it refused ~85% of every actionable wrapper setup: measured
 * over 25 sessions and 8 wrappers, 72.2% of FIRST fires per symbol/session land
 * in 09:30-10:00 and only 14.6% at or after 11:00. Two live sessions produced 23
 * wrapper fires and ZERO decisions — a gate that strict cannot accumulate the
 * evidence needed to judge itself.
 *
 * The measured effect is on win rate (10:00-11:00 47%/-0.36% n=30; 11:00-13:00
 * 54%/+0.42% n=13; 13:00+ 67%/+2.46% n=6), so it is now charged there. A strong
 * early setup can clear on its other merits while still paying for the hour.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { applyPolarity } = require('../lib/signal-engine/scan');

const good = { spy: { tape: -0.4, mom30: -0.2, ll: true }, wrapperDD: -0.6, underlyingTape: 0.2 };
const P = (o) => applyPolarity('SOXS', 'BULLISH', { shortEdge: 'selective', ...good, ...o });

test('the 09:30 fire that used to be BANNED is now allowed and priced', () => {
  const r = P({ etMin: 570 });
  assert.strictEqual(r.direction, 'BULLISH', 'no longer vetoed on the clock');
  assert.strictEqual(r.veto, null);
  assert.strictEqual(r.timePenaltyPp, 7);
  assert.match(r.allowed, /early/);
  assert.match(r.allowed, /was a hard block/);
});

test('the penalty is graded, not binary', () => {
  assert.strictEqual(P({ etMin: 570 }).timePenaltyPp, 7, '09:30 — before 10:00');
  assert.strictEqual(P({ etMin: 599 }).timePenaltyPp, 7, '09:59 — still the early band');
  assert.strictEqual(P({ etMin: 600 }).timePenaltyPp, 4, '10:00 — mid band');
  assert.strictEqual(P({ etMin: 659 }).timePenaltyPp, 4, '10:59 — still mid');
  assert.strictEqual(P({ etMin: 660 }).timePenaltyPp, 0, '11:00 — the old floor, now free');
  assert.strictEqual(P({ etMin: 900 }).timePenaltyPp, 0, '15:00 — free');
});

test('the SETUP checks stay HARD — only the clock was converted', () => {
  const hardFall = P({ etMin: 720, wrapperDD: -2.1 });
  assert.strictEqual(hardFall.direction, 'NEUTRAL');
  assert.match(hardFall.veto, /wrapper already fell/);
  const ripping = P({ etMin: 720, underlyingTape: 0.8 });
  assert.strictEqual(ripping.direction, 'NEUTRAL');
  assert.match(ripping.veto, /underlying ripping/);
});

test('an early fire with a BAD setup is still refused — the price is not a bypass', () => {
  const r = P({ etMin: 570, wrapperDD: -3.0 });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /wrapper already fell/);
});

test('unreadable inputs still refuse rather than certify blind', () => {
  for (const o of [{ etMin: null }, { wrapperDD: null }, { underlyingTape: null }]) {
    const r = P(o);
    assert.strictEqual(r.direction, 'NEUTRAL');
    assert.match(r.veto, /selection inputs unreadable/);
  }
});

test('the penalty bands are tunable, and 0 restores the un-penalised behaviour', () => {
  process.env.TRADER_SHORT_EARLY_PENALTY_PP = '12';
  process.env.TRADER_SHORT_MID_PENALTY_PP = '0';
  try {
    assert.strictEqual(P({ etMin: 570 }).timePenaltyPp, 12);
    assert.strictEqual(P({ etMin: 620 }).timePenaltyPp, 0);
  } finally {
    delete process.env.TRADER_SHORT_EARLY_PENALTY_PP;
    delete process.env.TRADER_SHORT_MID_PENALTY_PP;
  }
});

test('1x instruments never carry a time penalty — this prices economic shorts only', () => {
  const r = applyPolarity('SPY', 'BULLISH', { shortEdge: 'selective', ...good, etMin: 570 });
  assert.strictEqual(r.direction, 'BULLISH');
  assert.strictEqual(r.timePenaltyPp, undefined, 'a 1x long is not a wrapper fire');
});

test('the arithmetic the scan applies: 7pp off p_win, EV and decision re-derived', () => {
  // Mirrors the scoring site so the numbers are pinned independently of the wiring.
  const apply = (pWin, targetR, pp) => {
    const after = Math.max(0.05, pWin - pp / 100);
    const evR = Math.round((after * targetR - (1 - after)) * 1000) / 1000;
    const decision = (evR < 0.15 || after < 0.45) ? 'SKIP' : 'ENTER';
    return { after: Math.round(after * 10000) / 10000, evR, decision };
  };
  // comfortably above threshold: survives the charge
  const strong = apply(0.62, 2, 7);
  assert.ok(Math.abs(strong.after - 0.55) < 1e-9);
  assert.strictEqual(strong.decision, 'ENTER', 'a strong early setup still clears — the point of the change');
  // marginal: the charge is what tips it
  const marginal = apply(0.48, 2, 7);
  assert.ok(Math.abs(marginal.after - 0.41) < 1e-9);
  assert.strictEqual(marginal.decision, 'SKIP', 'and a marginal one is correctly priced out');
  // the floor never produces a negative probability
  assert.strictEqual(apply(0.06, 2, 7).after, 0.05);
});
