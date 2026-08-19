'use strict';

/**
 * correlated-risk-cap.test.js — counting risk by DIRECTION, not by symbol.
 *
 * Live incident 2026-08-13: the book held SOXS + SQQQ + SPXS at once. Three
 * different families, so the direction-lock (which only blocks OPPOSING
 * exposure) permitted all three, and the concurrency cap counted three
 * independent slots. They were one bet — "the market falls" — held in
 * triplicate. The market rallied (SPY +0.44%, QQQ +0.99%) and all three lost
 * together: -5.08%, -3.04%, -1.35%, about -$1,431 combined.
 *
 * Structural, not bad luck: IBS buys whatever sits at the bottom of its session
 * range, and in a rally that is always the inverse ETFs — so the engine
 * concentrates short exposure precisely when it is most wrong.
 *
 * NOTE ON THE DEFAULT: the portfolio replay (11.6y, 12,717 trades) shows this
 * cap is a straight risk-for-income trade with NO free lunch — cap 1 cuts the
 * worst day 48% but costs 75% of income; cap 3 costs 20% for a 24% better tail.
 * So it ships DISABLED (maxPerBucket 0) and is an opt-in risk preference, not a
 * measured improvement. These tests pin the mechanism, not a recommendation.
 */

const test = require('node:test');
const assert = require('node:assert');
const { riskBucket, bucketCounts } = require('../lib/direction-lock');

test('every inverse equity ETF collapses into ONE bucket', () => {
  for (const s of ['SOXS', 'SQQQ', 'SPXS', 'TZA']) {
    assert.strictEqual(riskBucket(s), 'equity_short', `${s} is a short-the-market bet`);
  }
});

test('longs — broad, leveraged, sector, international — share the long bucket', () => {
  for (const s of ['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'SOXL', 'TQQQ', 'SPXL', 'TNA', 'XLK', 'XLU', 'EEM', 'EFA']) {
    assert.strictEqual(riskBucket(s), 'equity_long', `${s} is long equity beta`);
  }
});

test('precious metals share a bucket; bonds stand alone', () => {
  for (const s of ['GLD', 'SLV', 'GDX']) assert.strictEqual(riskBucket(s), 'metals');
  assert.strictEqual(riskBucket('TLT'), 'TLT', 'bonds are not equity beta and not metals');
});

test('an unknown symbol gets its own bucket — never assume correlation we cannot assert', () => {
  assert.strictEqual(riskBucket('ZZZZ'), 'ZZZZ');
});

test('the exact 2026-08-13 book counts as THREE in one bucket', () => {
  const held = [
    { symbol: 'SOXS', qty: 1490.8 }, { symbol: 'SQQQ', qty: 1614 },
    { symbol: 'SPXS', qty: 2467 }, { symbol: 'GLD', qty: 147 },
  ];
  const c = bucketCounts(held);
  assert.strictEqual(c.equity_short, 3, 'the concentration the cap exists to bound');
  assert.strictEqual(c.metals, 1);
});

test('dust is not exposure — the 0.8-share remnant cannot fill an order', () => {
  const c = bucketCounts([{ symbol: 'SOXS', qty: 0.8 }, { symbol: 'SQQQ', qty: 1614 }]);
  assert.strictEqual(c.equity_short, 1, 'an untradeable stub is not a risk slot');
});

// Mirrors the production gate.
const blocked = (held, sym, max, openedThisScan = {}) => {
  if (!(max > 0)) return false;
  const b = riskBucket(sym);
  return ((bucketCounts(held)[b] || 0) + (openedThisScan[b] || 0)) >= max;
};

test('cap 2 would have refused the third inverse on 2026-08-13', () => {
  const two = [{ symbol: 'SOXS', qty: 1490 }, { symbol: 'SQQQ', qty: 1614 }];
  assert.strictEqual(blocked(two, 'SPXS', 2), true, 'the third leg of the same bet is refused');
  assert.strictEqual(blocked(two, 'GLD', 2), false, 'an uncorrelated bucket is unaffected');
  assert.strictEqual(blocked(two, 'SPY', 2), false, 'the opposite direction is a different bucket');
});

test('cap 0 disables the gate entirely (shipped default)', () => {
  const three = [{ symbol: 'SOXS', qty: 1 }, { symbol: 'SQQQ', qty: 1 }, { symbol: 'SPXS', qty: 1 }];
  assert.strictEqual(blocked(three, 'TZA', 0), false, 'default behaviour must be unchanged');
});

test('same-scan entries count — the snapshot blind spot that broke the concurrency cap', () => {
  const one = [{ symbol: 'SOXS', qty: 1490 }];
  assert.strictEqual(blocked(one, 'SQQQ', 2, {}), false, 'first of the scan: room remains');
  assert.strictEqual(blocked(one, 'SPXS', 2, { equity_short: 1 }), true,
    'a second entry in the SAME scan must see the slot it just took');
});
