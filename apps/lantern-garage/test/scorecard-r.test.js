'use strict';
/**
 * test/scorecard-r.test.js — #3550.
 *
 * An R multiple divided by anything other than the risk taken at entry is not an R
 * multiple: divide by a stop that was ratcheted to break-even and a full winner reads as
 * infinite R while a scratch reads as a disaster. So what is pinned here is mostly the
 * denominator — where it comes from, what happens when it is missing, and that a
 * distribution drawn from part of the record says which part.
 *
 * Run: node --test apps/lantern-garage/test/scorecard-r.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { rBasisOf, rOf, rHistogram, rDistribution, breakdownFromRows, BREAKDOWN_KEYS } = require('../lib/trader-scorecard');

const exit = (o) => Object.assign({
  ts: '2026-08-03T14:30:00.000Z', event: 'exit', symbol: 'SPY', qty: 10, entry: 100,
  pnl: 30, pnl_pct: 3, status: 'filled',
}, o);

test('by=r is a supported slice', () => {
  assert.ok(BREAKDOWN_KEYS.includes('r'));
});

test('the denominator is the recorded stop distance when it is there', () => {
  assert.strictEqual(rBasisOf(exit({ stop_dist_pct: 3 })), 3);
  assert.strictEqual(rOf(exit({ stop_dist_pct: 3, pnl_pct: 3 })), 1, 'a winner the size of the stop is +1R');
  assert.strictEqual(rOf(exit({ stop_dist_pct: 3, pnl_pct: -3 })), -1);
  assert.strictEqual(rOf(exit({ stop_dist_pct: 3, pnl_pct: 1.5 })), 0.5);
});

test('the recorded distance wins over anything that could be back-derived', () => {
  // If the two ever disagree, the recorded one is the risk that was actually taken;
  // the derived one is an inference from an excursion that may have its own history.
  const row = exit({ stop_dist_pct: 3, mfe_pct: 9, mfe_r: 1 });     // back-derivation would say 9
  assert.strictEqual(rBasisOf(row), 3);
});

test('an older row without the field is recovered through its excursion fields', () => {
  assert.strictEqual(rBasisOf(exit({ mfe_pct: 6, mfe_r: 2 })), 3, 'mfe_r = mfe_pct / basis');
  // A trade that only ever went against us has no MFE, and used to be uncountable.
  assert.strictEqual(rBasisOf(exit({ mfe_pct: null, mfe_r: null, mae_pct: -1.5, mae_r: -0.5 })), 3);
});

test('a trade whose risk was never recorded has no R, rather than a plausible one', () => {
  assert.strictEqual(rBasisOf(exit({})), null);
  assert.strictEqual(rOf(exit({})), null);
  assert.strictEqual(rBasisOf(exit({ stop_dist_pct: 0 })), null, 'a zero stop is not a denominator');
  assert.strictEqual(rBasisOf(exit({ mfe_pct: 5, mfe_r: 0 })), null, 'and neither is a zero R');
  assert.strictEqual(rOf(exit({ stop_dist_pct: 3, pnl_pct: null })), null, 'an unpriced trade has no result to divide');
});

test('the histogram covers every value, once', () => {
  const values = [-1.04, -0.6, -0.2, 0.05, 0.1, 0.3, 1.1];
  const h = rHistogram(values);
  assert.ok(h.width > 0);
  assert.strictEqual(h.buckets.reduce((n, b) => n + b.count, 0), values.length);
  for (let i = 1; i < h.buckets.length; i++) {
    assert.strictEqual(h.buckets[i].from, h.buckets[i - 1].to, 'buckets are contiguous, with no gap to fall into');
  }
  assert.ok(h.buckets[0].from <= Math.min(...values));
  assert.ok(h.buckets[h.buckets.length - 1].to >= Math.max(...values));
});

test('the value sitting exactly on the top edge lands in the last bucket, not outside it', () => {
  const h = rHistogram([0, 1]);
  assert.strictEqual(h.buckets.reduce((n, b) => n + b.count, 0), 2);
  assert.strictEqual(h.buckets[h.buckets.length - 1].count >= 1, true);
});

test('zero is always a bucket EDGE, so no bucket mixes winners with losers', () => {
  for (const values of [[-1.04, 1.1], [-0.3, 0.02], [-5, 5], [-0.04, 0.09]]) {
    const h = rHistogram(values);
    for (const b of h.buckets) {
      assert.ok(b.from >= 0 || b.to <= 0, 'bucket ' + b.from + '..' + b.to + ' straddles zero');
    }
  }
});

test('the bucket width adapts, because this trader lives inside 1R', () => {
  // Fixed 1R buckets would render the whole record as two bars.
  const tight = rHistogram([-0.3, -0.1, 0.02, 0.05, 0.12, 0.3]);
  assert.ok(tight.width <= 0.1, 'a tight book gets a fine width, got ' + tight.width);
  const wide = rHistogram([-8, -2, 0.5, 3, 11]);
  assert.ok(wide.width >= 1, 'a wide book gets a coarse one, got ' + wide.width);
  assert.ok(tight.buckets.length >= 4 && tight.buckets.length <= 24);
  assert.ok(wide.buckets.length >= 4 && wide.buckets.length <= 24);
});

test('one value, or none, does not blow up', () => {
  assert.deepStrictEqual(rHistogram([]), { width: 0, buckets: [] });
  const one = rHistogram([0.4]);
  assert.strictEqual(one.buckets.reduce((n, b) => n + b.count, 0), 1);
});

test('the summary is the shape, not just the average', () => {
  const rows = [
    exit({ stop_dist_pct: 3, pnl_pct: 3 }),      // +1R
    exit({ stop_dist_pct: 3, pnl_pct: 1.5 }),    // +0.5R
    exit({ stop_dist_pct: 3, pnl_pct: 0.6 }),    // +0.2R
    exit({ stop_dist_pct: 3, pnl_pct: -3 }),     // -1R
  ].map((r, i) => Object.assign(r, { symbol: 'S' + i }));   // distinct, so nothing dedupes
  const d = rDistribution(rows);
  assert.deepStrictEqual([d.n, d.withR, d.coverage], [4, 4, 100]);
  assert.deepStrictEqual([d.wins, d.losses], [3, 1]);
  assert.strictEqual(d.best, 1);
  assert.strictEqual(d.worst, -1);
  assert.strictEqual(d.avgWinR, 0.57);
  assert.strictEqual(d.avgLossR, -1);
  assert.strictEqual(d.payoff, 0.57, 'what a winner returns per unit a loser costs');
  assert.strictEqual(d.median, 0.35, 'the middle of 0.2, 0.5 either side');
});

test('a distribution drawn from part of the record says which part', () => {
  // This is the whole reason `withR` exists: before #3550 the basis was only
  // recoverable for trades whose excursion happened to be observed.
  const rows = [
    exit({ symbol: 'A', stop_dist_pct: 3, pnl_pct: 3 }),
    exit({ symbol: 'B', pnl_pct: 3 }),                     // no basis at all
    exit({ symbol: 'C', pnl_pct: -3 }),                    // no basis at all
  ];
  const d = rDistribution(rows);
  assert.strictEqual(d.n, 3, 'every priced trade is counted');
  assert.strictEqual(d.withR, 1, 'but only one could be turned into an R');
  assert.strictEqual(d.coverage, 33.3);
  assert.strictEqual(d.buckets.reduce((n, b) => n + b.count, 0), 1, 'the bars only ever show what is known');
});

test('nothing measurable is an empty summary, not a zero one', () => {
  const d = rDistribution([exit({ symbol: 'A', pnl_pct: 2 })]);
  assert.deepStrictEqual([d.n, d.withR, d.coverage], [1, 0, 0]);
  assert.deepStrictEqual([d.mean, d.median, d.payoff, d.best, d.worst], [null, null, null, null, null]);
  assert.deepStrictEqual(d.buckets, []);
  const none = rDistribution([]);
  assert.deepStrictEqual([none.n, none.withR], [0, 0]);
});

test('by=r keeps the confirmed/all split every other slice has', () => {
  const rows = [
    exit({ symbol: 'A', stop_dist_pct: 3, pnl_pct: 3, status: 'filled' }),
    exit({ symbol: 'B', stop_dist_pct: 3, pnl_pct: -3, status: 'dry_run' }),   // strategy view only
    exit({ symbol: 'C', stop_dist_pct: 3, pnl_pct: 99, status: 'rejected' }),  // realized nothing, neither view
  ];
  const r = breakdownFromRows('r', rows, null);
  assert.strictEqual(r.by, 'r');
  assert.match(r.basis, /entry/);
  assert.strictEqual(r.confirmed.withR, 1, 'a dry run is not a booked outcome');
  assert.strictEqual(r.all.withR, 2, 'but it is a decision the strategy made');
  assert.strictEqual(r.confirmed.best, 1);
  assert.ok(!JSON.stringify(r).includes('99'), 'a rejected attempt reaches neither view');
});
