'use strict';

const test = require('node:test');
const assert = require('node:assert');
const c = require('../lib/champion-contest');

test('buildHoldings: buys the weighted mix in fractional shares, scaled by gross', () => {
  const h = c.buildHoldings({ SPY: 0.6, GLD: 0.4 }, { SPY: 100, GLD: 50 }, 100000, 1);
  assert.ok(Math.abs(h.SPY - 600) < 1e-6);     // 60k / $100
  assert.ok(Math.abs(h.GLD - 800) < 1e-6);     // 40k / $50
  const hLev = c.buildHoldings({ SPY: 1.0 }, { SPY: 100 }, 100000, 2);
  assert.ok(Math.abs(hLev.SPY - 2000) < 1e-6); // 2× gross → $200k notional / $100
  // zero-price / zero-weight legs are skipped
  const h0 = c.buildHoldings({ SPY: 0.5, ZZZ: 0.5 }, { SPY: 100, ZZZ: 0 }, 100000, 1);
  assert.ok(!('ZZZ' in h0));
});

test('markBook: equity = cash + Σ shares·price; return vs start', () => {
  const book = { startEquity: 100000, cash: 0, holdings: { SPY: 600, GLD: 800 } };
  const flat = c.markBook(book, { SPY: 100, GLD: 50 });
  assert.strictEqual(flat.equity, 100000);
  assert.strictEqual(flat.returnPct, 0);
  const up = c.markBook(book, { SPY: 110, GLD: 55 });   // +10% on both
  assert.strictEqual(up.equity, 110000);
  assert.strictEqual(up.returnPct, 10);
  // cash carries flat
  const withCash = c.markBook({ startEquity: 100000, cash: 20000, holdings: { SPY: 800 } }, { SPY: 100 });
  assert.strictEqual(withCash.equity, 100000);
});

test('rankBooks: best return first, ties broken by later start; ranks assigned', () => {
  const ranked = c.rankBooks([
    { name: 'A', returnPct: 3, startedAt: '2026-07-01T00:00:00Z' },
    { name: 'B', returnPct: 8, startedAt: '2026-07-02T00:00:00Z' },
    { name: 'C', returnPct: 3, startedAt: '2026-07-05T00:00:00Z' },   // ties A, later start → ahead
  ]);
  assert.deepStrictEqual(ranked.map((r) => r.name), ['B', 'C', 'A']);
  assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 2, 3]);
});

test('markBook: a losing book reports a negative return', () => {
  const m = c.markBook({ startEquity: 100000, cash: 0, holdings: { SPY: 1000 } }, { SPY: 90 });
  assert.strictEqual(m.equity, 90000);
  assert.strictEqual(m.returnPct, -10);
});

test('planBadge: resolves Free/Pro/Pilot robustly, incl. the pilot-role gap', () => {
  assert.strictEqual(c.planBadge('guest'), 'free');
  assert.strictEqual(c.planBadge('deep_dreamer'), 'pro');
  assert.strictEqual(c.planBadge('pilot'), 'pilot');       // role IS a plan → honored (plan-matrix would say 'free')
  assert.strictEqual(c.planBadge('admin'), 'pilot');       // staff → top badge
  assert.strictEqual(c.planBadge('guest', 'pilot'), 'pilot'); // tier field wins when it's a plan
  assert.strictEqual(c.planBadge(null, null), 'free');
});
