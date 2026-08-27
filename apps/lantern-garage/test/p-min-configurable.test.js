'use strict';
/**
 * p-min-configurable.test.js — the hit-rate floor is a measurement, not a constant.
 *
 * `P_MIN` gates every entry: `decision = has_evidence && ev_r >= EV_MIN && p_win >= P_MIN`.
 * It was hardcoded at 0.45, which meant the one number deciding what the engine is
 * allowed to buy could not be A/B'd without editing source.
 *
 * 84 live entries joined to their exits (both boxes, from 2026-08-10) say the band
 * that floor admits is the losing one:
 *
 *   p_win band      n     WR       avg
 *   0.00-0.50      23    39%   -0.341%      <- admitted by P_MIN=0.45
 *   0.50-0.55      16    63%   +0.594%
 *   0.55-0.60      20    85%   +0.639%
 *
 * This does not change the default. It makes the number testable, so 0.45 and 0.50 can
 * run side by side on the two boxes and the answer can come from the tape rather than
 * from a backtest that cannot represent it (the replay harness feeds a constant p_win,
 * and rebuilding the real one from bars would neutralise 41% of the model's weight).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.join(__dirname, '..', 'lib', 'signal-engine', 'convergence-ev.js');
// P_MIN is read at module load, so each case needs a fresh require
const loadWith = (val) => {
  const prev = process.env.TRADER_P_MIN;
  if (val === undefined) delete process.env.TRADER_P_MIN; else process.env.TRADER_P_MIN = val;
  delete require.cache[require.resolve(MOD)];
  try { return require(MOD); } finally {
    if (prev === undefined) delete process.env.TRADER_P_MIN; else process.env.TRADER_P_MIN = prev;
    delete require.cache[require.resolve(MOD)];
  }
};

test('unset keeps the historical default — this change arms nothing by itself', () => {
  assert.strictEqual(loadWith(undefined).P_MIN, 0.45);
});

test('a valid value is honoured', () => {
  assert.strictEqual(loadWith('0.50').P_MIN, 0.50);
  assert.strictEqual(loadWith('0.62').P_MIN, 0.62);
});

test('garbage falls back to the default rather than disabling the floor', () => {
  // a floor that silently becomes NaN would compare false against every p_win and
  // admit nothing — or, read the other way, admit everything. Neither is acceptable
  // for the gate that decides what may be bought.
  for (const bad of ['', 'abc', 'NaN', 'null', '-1', '0', '1', '1.5', '99']) {
    assert.strictEqual(loadWith(bad).P_MIN, 0.45, `TRADER_P_MIN=${JSON.stringify(bad)} must fall back`);
  }
});

test('the floor actually gates the decision at the configured level', () => {
  // drive scoreConvergence with evidence weak enough to land between the two floors,
  // and confirm the verdict flips with the knob rather than staying pinned.
  const weakEvidence = {
    direction: 'BULLISH', target_r: 2.0,
    in_zone: true, zone_strength: 30, zone_touches: 1,
    structure_confirmed: false, pattern_grade: 'C',
    trend_agrees: false, news_sentiment: 0, volume_ratio: 1.0,
    macd_hist: -0.01, price_vs_ma: -0.2,
  };
  const lo = loadWith('0.05');   // floor below anything -> the EV gate alone decides
  const hi = loadWith('0.95');   // floor above anything -> nothing can ENTER
  const a = lo.scoreConvergence(weakEvidence);
  const b = hi.scoreConvergence(weakEvidence);
  assert.strictEqual(b.decision, 'SKIP', 'an unreachable floor must refuse');
  assert.ok(a.p_win === b.p_win, 'the SCORE is unchanged — only the threshold moves');
  assert.ok(['ENTER', 'SKIP'].includes(a.decision));
});

test('P_MIN is exported so the engine and its tests read one number', () => {
  const m = loadWith('0.50');
  assert.strictEqual(m.P_MIN, 0.50);
  assert.strictEqual(typeof m.EV_MIN, 'number', 'the EV floor is still exported alongside it');
});
