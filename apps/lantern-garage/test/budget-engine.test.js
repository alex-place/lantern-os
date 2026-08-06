'use strict';
// Deterministic checks for the budget engine (public/js/budget-engine.js). The whole point of
// the tool is that every number is computed from a cited rule, so the rules must be pinned.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const E = require(path.join(__dirname, '..', 'public', 'js', 'budget-engine.js'));

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('savings rate = (income - non-savings spend) / income, and bands are correct', () => {
  // income 5000, spend 4000 (housing 1500 + everything else) → surplus 1000 → 20% → Good
  const r = E.analyze({ income: 5000, categories: { housing: 1500, groceries: 500, transportation: 500, dining: 500, personal: 1000 } });
  assert.ok(near(r.spend, 4000), 'spend ' + r.spend);
  assert.ok(near(r.surplus, 1000));
  assert.ok(near(r.savingsRate, 0.20), 'rate ' + r.savingsRate);
  assert.strictEqual(r.band.key, 'good'); // 0.20 is the good floor (fair is <0.20)
});

test('band thresholds: <10 poor, 10-20 fair, 20-30 good, >=30 excellent', () => {
  assert.strictEqual(E.savingsBand(0.05).key, 'poor');
  assert.strictEqual(E.savingsBand(0.099).key, 'poor');
  assert.strictEqual(E.savingsBand(0.10).key, 'fair');
  assert.strictEqual(E.savingsBand(0.20).key, 'good');
  assert.strictEqual(E.savingsBand(0.30).key, 'excellent');
  assert.strictEqual(E.savingsBand(0.55).key, 'excellent');
});

test('the explicit savings/investing category is NOT counted as spending', () => {
  // income 4000, real spend 2000, plus 800 moved to investing → spend must stay 2000, rate 50%
  const r = E.analyze({ income: 4000, categories: { housing: 1200, groceries: 800, savings: 800 } });
  assert.ok(near(r.spend, 2000), 'spend ' + r.spend);
  assert.ok(near(r.savingsRate, 0.50));
  assert.ok(near(r.explicitSavings, 800));
});

test('housing over 30% of income raises a HIGH flag; 28-30% raises a warn', () => {
  const high = E.analyze({ income: 4000, categories: { housing: 1400 } }); // 35%
  assert.ok(high.flags.some((f) => f.category === 'housing' && f.level === 'high'));
  const warn = E.analyze({ income: 4000, categories: { housing: 1160 } }); // 29%
  const hf = warn.flags.find((f) => f.category === 'housing');
  assert.strictEqual(hf.level, 'warn');
  assert.ok(hf.benchmark.includes('http'), 'flag carries a source url');
});

test('debt-to-income: >36% warns, >43% is high risk (housing + debt back-end)', () => {
  const warn = E.analyze({ income: 5000, categories: { housing: 1500, debt: 500 } }); // 40%
  assert.ok(warn.flags.some((f) => f.category === 'debt' && f.level === 'warn'));
  const high = E.analyze({ income: 5000, categories: { housing: 1800, debt: 500 } }); // 46%
  assert.ok(high.flags.some((f) => f.category === 'debt' && f.level === 'high'));
});

test('transportation soft flag >10%, warn >15%', () => {
  const soft = E.analyze({ income: 4000, categories: { transportation: 480 } }); // 12%
  assert.strictEqual(soft.flags.find((f) => f.category === 'transportation').level, 'soft');
  const warn = E.analyze({ income: 4000, categories: { transportation: 720 } }); // 18%
  assert.strictEqual(warn.flags.find((f) => f.category === 'transportation').level, 'warn');
});

test('50/30/20: needs>50% and wants>30% each flag against take-home', () => {
  const r = E.analyze({ income: 4000, categories: { housing: 1600, groceries: 600, dining: 900, personal: 400 } });
  // needs = 1600+600 = 2200 (55%) > 50; wants = 900+400 = 1300 (32.5%) > 30
  assert.ok(r.flags.some((f) => f.category === 'needs' && f.level === 'warn'));
  assert.ok(r.flags.some((f) => f.category === 'wants' && f.level === 'warn'));
  assert.ok(near(r.split.needs.pct, 0.55));
});

test('emergency fund months computed only when the optional inputs are given', () => {
  const none = E.analyze({ income: 4000, categories: { housing: 1200, groceries: 600 } });
  assert.strictEqual(none.emergencyMonths, null);
  const under = E.analyze({ income: 4000, categories: { housing: 1200, groceries: 600 }, emergencySavings: 1800 }); // essentials 1800 → 1 month
  assert.strictEqual(under.emergencyMonths, 1.0);
  assert.ok(under.flags.some((f) => f.category === 'emergency' && f.level === 'high'));
});

test('flags are priority-sorted: emergency < DTI-high < savings-critical < housing', () => {
  const r = E.analyze({ income: 4000, categories: { housing: 1500, debt: 400, groceries: 800 }, emergencySavings: 500 });
  const cats = r.flags.map((f) => f.category);
  assert.strictEqual(cats[0], 'emergency'); // priority 1 wins
});

test('recommendations quantify the gap to a 20% savings rate in dollars', () => {
  const r = E.analyze({ income: 5000, categories: { housing: 2000, groceries: 800, dining: 700, personal: 700 } }); // spend 4200 → 16% rate
  const head = r.recommendations[0];
  assert.strictEqual(head.category, 'savings');
  assert.ok(/month/.test(head.text) && /\$/.test(head.text), 'headline quantifies the monthly gap: ' + head.text);
  // over-benchmark categories surface trim ideas
  assert.ok(r.recommendations.some((x) => x.category === 'housing' && Array.isArray(x.ideas)));
});

test('a healthy budget: at/above target gives an encouraging headline, no trim spam', () => {
  const r = E.analyze({ income: 6000, categories: { housing: 1500, groceries: 500, transportation: 400, dining: 300, personal: 300 } }); // spend 3000 → 50% rate
  assert.strictEqual(r.band.key, 'excellent');
  assert.ok(/target/.test(r.recommendations[0].text));
  assert.strictEqual(r.recommendations.filter((x) => x.ideas).length, 0, 'no trim ideas when nothing is over benchmark');
});

test('zero / empty income is handled without NaN', () => {
  const r = E.analyze({ income: 0, categories: {} });
  assert.strictEqual(r.savingsRate, 0);
  assert.ok(Number.isFinite(r.dti));
  assert.strictEqual(r.recommendations[0].category, 'income');
});
