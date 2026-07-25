'use strict';
/** capital-allocator.js — pure allocation math (one book over the trader sleeves). */
const test = require('node:test');
const assert = require('node:assert');
const { allocate, sleeveScore, CAP_PCT, FLOOR_PCT, MIN_N } = require('../lib/capital-allocator');

test('unproven sleeves get exploration floors only, rest cash', () => {
  const a = allocate({ equity: 100000, evidence: {} });
  for (const s of Object.keys(FLOOR_PCT)) {
    assert.strictEqual(a.sleeves[s].pct, FLOOR_PCT[s], s + ' at floor');
    assert.strictEqual(a.sleeves[s].proven, false);
  }
  assert.ok(a.cash_pct > 90, 'unproven book is mostly cash');
});

test('a proven sleeve earns budget up to its cap; evidence shrinkage works', () => {
  const proven = { n: 200, avg: 0.002, sd: 0.009 };  // strong overnight-like edge
  const a = allocate({ equity: 100000, evidence: { overnight: proven } });
  assert.ok(a.sleeves.overnight.pct > FLOOR_PCT.overnight, 'proven sleeve above floor');
  assert.ok(a.sleeves.overnight.pct <= CAP_PCT.overnight, 'capped');
  assert.strictEqual(a.sleeves.overnight.proven, true);
  // Same edge with thin evidence scores lower.
  const thin = sleeveScore({ n: 5, avg: 0.002, sd: 0.009 }, MIN_N.overnight);
  const deep = sleeveScore(proven, MIN_N.overnight);
  assert.ok(thin < deep, 'shrinkage by n');
});

test('regime damper pins intraday to its floor in a downtrend', () => {
  const hot = { n: 500, avg: 0.004, sd: 0.01 };
  const up = allocate({ equity: 100000, evidence: { intraday: hot }, regime: 'up' });
  const down = allocate({ equity: 100000, evidence: { intraday: hot }, regime: 'down' });
  assert.ok(up.sleeves.intraday.pct > FLOOR_PCT.intraday, 'earns budget in uptrend');
  assert.strictEqual(down.sleeves.intraday.pct, FLOOR_PCT.intraday, 'floored in downtrend');
});

test('negative-expectancy evidence earns nothing beyond the floor', () => {
  const losing = { n: 300, avg: -0.003, sd: 0.01 };
  const a = allocate({ equity: 100000, evidence: { intraday: losing } });
  assert.strictEqual(a.sleeves.intraday.pct, FLOOR_PCT.intraday);
  assert.strictEqual(a.sleeves.intraday.score, 0, 'Kelly floor at zero — never negative');
});

test('budgets sum with cash to 100%', () => {
  const a = allocate({ equity: 50000, evidence: { overnight: { n: 100, avg: 0.001, sd: 0.008 }, options: { n: 50, avg: 0.2, sd: 1.0 } } });
  const total = Object.values(a.sleeves).reduce((x, s) => x + s.pct, 0) + a.cash_pct;
  assert.ok(Math.abs(total - 100) < 0.05, 'pct conservation, got ' + total);
});
