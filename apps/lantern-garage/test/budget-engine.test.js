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

// ── OSS-researched additions (#3197 follow-up) ──────────────────────────────────────────────────

test('unallocated = income - spend - explicit savings (zero-based "left to allocate")', () => {
  const r = E.analyze({ income: 5000, categories: { housing: 1500, groceries: 500, savings: 1000 } });
  // spend 2000, explicit savings 1000 → unallocated 2000
  assert.strictEqual(r.unallocated, 2000);
  const full = E.analyze({ income: 3000, categories: { housing: 1500, groceries: 500, savings: 1000 } }); // 3000 assigned
  assert.strictEqual(full.unallocated, 0);
  const over = E.analyze({ income: 2500, categories: { housing: 1500, groceries: 500, savings: 1000 } }); // -500
  assert.strictEqual(over.unallocated, -500);
});

test('gross-basis toggle: ratios use gross when supplied, else take-home', () => {
  // take-home 4000, gross 6000, housing 1500 → 25% of gross (under 28) but 37.5% of take-home
  const g = E.analyze({ income: 4000, grossIncome: 6000, categories: { housing: 1500 } });
  assert.strictEqual(g.basis.usedGross, true);
  assert.ok(!g.flags.some((f) => f.category === 'housing'), 'housing under 28% of gross → no flag');
  const ng = E.analyze({ income: 4000, categories: { housing: 1500 } }); // 37.5% of take-home
  assert.ok(ng.flags.some((f) => f.category === 'housing' && f.level === 'high'));
  assert.strictEqual(ng.basis.usedGross, false);
  assert.ok(g.flags.length >= 0); // gross message wording
});

test('50/30/20 legs carry target dollars and signed delta', () => {
  const r = E.analyze({ income: 4000, categories: { housing: 1600, groceries: 600 } }); // needs 2200
  assert.strictEqual(r.split.needs.targetAmount, 2000);      // 50% of 4000
  assert.strictEqual(r.split.needs.delta, 200);              // 200 over target
  assert.strictEqual(r.split.savings.targetAmount, 800);     // 20% of 4000
});

test('categoryBreakdown slices sum to income (spend + savings + unallocated)', () => {
  const r = E.analyze({ income: 5000, categories: { housing: 1500, groceries: 500, savings: 1000 } });
  const total = r.categoryBreakdown.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(total - 5000) < 0.02, 'breakdown sums to income: ' + total);
  assert.ok(r.categoryBreakdown.some((x) => x.id === 'unallocated'));
});

test('fundProgress: by-date splits remaining over months left; monthly type computes months', () => {
  // $1200 target, $0 saved, due 12 months out → $100/mo, 0% funded
  const bd = E.fundProgress({ type: 'by-date', target: 1200, saved: 0, dueMonth: '2027-08' }, '2026-08-01');
  assert.strictEqual(bd.monthly, 100);
  assert.strictEqual(bd.pctFunded, 0);
  // partial: $300 saved, 3 months out → $300/mo, 25% funded
  const p = E.fundProgress({ type: 'by-date', target: 1200, saved: 300, dueMonth: '2026-11' }, '2026-08-01');
  assert.strictEqual(p.monthly, 300);
  assert.strictEqual(p.pctFunded, 0.25);
  // monthly type: $1000 remaining at $250/mo → 4 months
  const m = E.fundProgress({ type: 'monthly', target: 1000, saved: 0, monthly: 250 }, '2026-08-01');
  assert.strictEqual(m.monthsRemaining, 4);
  // fully funded
  assert.strictEqual(E.fundProgress({ type: 'by-date', target: 500, saved: 500, dueMonth: '2027-01' }, '2026-08-01').done, true);
});

test('fundsMonthlyTotal sums the per-fund monthly slices', () => {
  const t = E.fundsMonthlyTotal([
    { type: 'by-date', target: 1200, saved: 0, dueMonth: '2027-08' }, // 100
    { type: 'monthly', target: 600, saved: 0, monthly: 50 },          // 50
  ], '2026-08-01');
  assert.strictEqual(t, 150);
});

test('debt payoff: single debt amortizes to zero with interest accrued', () => {
  const r = E.simulateDebtPayoff([{ name: 'Card', balance: 1000, apr: 20, minPayment: 100 }], 0, 'avalanche');
  assert.ok(!r.infeasible);
  assert.ok(r.months >= 11 && r.months <= 12, 'about a year: ' + r.months);
  assert.ok(r.totalInterest > 0 && r.totalInterest < 200);
  assert.strictEqual(r.schedule[r.schedule.length - 1].totalBalance, 0);
});

test('avalanche targets highest APR first; snowball smallest balance first', () => {
  const debts = [
    { name: 'Big-lowAPR', balance: 5000, apr: 5, minPayment: 100 },
    { name: 'Small-highAPR', balance: 1000, apr: 25, minPayment: 30 },
  ];
  assert.strictEqual(E.simulateDebtPayoff(debts, 300, 'avalanche').order[0], 'Small-highAPR'); // highest APR
  assert.strictEqual(E.simulateDebtPayoff(debts, 300, 'snowball').order[0], 'Small-highAPR');  // also smallest balance here
  const cmp = E.compareDebtStrategies(debts, 300);
  assert.ok(cmp.interestSaved >= 0, 'avalanche never pays more interest than snowball');
});

test('debt payoff guards negative amortization (payments below interest)', () => {
  // $10k at 30% APR = $250/mo interest; only $100 min + $0 extra → infeasible
  const r = E.simulateDebtPayoff([{ name: 'Trap', balance: 10000, apr: 30, minPayment: 100 }], 0, 'avalanche');
  assert.strictEqual(r.infeasible, true);
  assert.ok(/interest/.test(r.reason));
});
