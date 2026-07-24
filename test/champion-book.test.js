'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cb = require('../lib/champion-book');

test('solve: solves a small linear system', () => {
  const x = cb.solve([[2, 1], [1, 3]], [3, 5]);   // x=0.8, y=1.4
  assert.ok(Math.abs(x[0] - 0.8) < 1e-9 && Math.abs(x[1] - 1.4) < 1e-9);
  assert.strictEqual(cb.solve([[0, 0], [0, 0]], [1, 1]), null);   // singular → null
});

test('tangencyDir: long-only weights that sum to 1 and respect the per-asset cap', () => {
  const mu = [0.02, 0.015, 0.01];
  const cov = [[0.04, 0.01, 0.005], [0.01, 0.05, 0.008], [0.005, 0.008, 0.03]];
  const w = cb.tangencyDir(mu, cov, { cap: 0.5 });
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'sums to 1');
  assert.ok(w.every((x) => x >= 0), 'no shorts');
  assert.ok(w.every((x) => x <= 0.5 + 1e-9), 'respects cap');
});

test('tangencyDir: the cap actually binds when one asset dominates', () => {
  const mu = [0.10, 0.001, 0.001];   // asset 0 hugely favored
  const cov = [[0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.02]];
  const w = cb.tangencyDir(mu, cov, { cap: 0.4 });
  assert.ok(w[0] <= 0.4 + 1e-9, 'dominant asset capped at 0.4');
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('targetWeights: drops assets without enough history, weights the rest', () => {
  // SPY/TLT have history; GLD too short → dropped.
  const closes = (n, drift) => Array.from({ length: n }, (_, i) => 100 * Math.pow(1 + drift, i));
  const out = cb.targetWeights({ SPY: closes(200, 0.001), TLT: closes(200, 0.0005), GLD: closes(10, 0.002) });
  assert.ok(out.used.includes('SPY') && out.used.includes('TLT'));
  assert.ok(out.dropped.includes('GLD'));
  assert.ok(Math.abs(Object.values(out.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test('computeRebalance: gross scales targets; no-churn band suppresses tiny drifts', () => {
  const r = cb.computeRebalance({
    equity: 100000, gross: 1.5,
    weights: { SPY: 0.5, TLT: 0.5 },
    prices: { SPY: 100, TLT: 100 },
    positions: [{ symbol: 'SPY', market_value: 74000 }],   // target 75k → 1k drift
    bandPct: 0.6,                                           // band = $600 → 1k trades
  });
  // SPY target = 100000 * 1.5 * 0.5 = 75,000; drift +1,000 > $600 band → buy
  const spy = r.orders.find((o) => o.symbol === 'SPY');
  assert.ok(spy && spy.side === 'buy' && spy.notional === 1000);
  // TLT target 75,000, held 0 → buy the full leg
  assert.ok(r.orders.find((o) => o.symbol === 'TLT' && o.side === 'buy'));
  assert.strictEqual(r.grossUsed, 1.5);
});

test('computeRebalance: within-band drift is left alone; excluded holdings are sold', () => {
  const r = cb.computeRebalance({
    equity: 100000, gross: 1,
    weights: { SPY: 1.0 },                                  // TLT no longer in the book → sell it
    prices: { SPY: 100, TLT: 50 },
    positions: [{ symbol: 'SPY', market_value: 99800 }, { symbol: 'TLT', market_value: 5000 }],
    bandPct: 0.6,                                           // band $600
  });
  assert.ok(!r.orders.find((o) => o.symbol === 'SPY'), 'SPY within band → no trade');
  const tlt = r.orders.find((o) => o.symbol === 'TLT');
  assert.ok(tlt && tlt.side === 'sell' && tlt.notional === 5000, 'excluded TLT fully sold');
});

test('computeRebalance: gross clamps to [0, MAX_GROSS]; sells ordered before buys', () => {
  const r = cb.computeRebalance({ equity: 100000, gross: 9, weights: { SPY: 1 }, prices: { SPY: 100 }, positions: [] });
  assert.strictEqual(r.grossUsed, cb.MAX_GROSS);   // 9 clamped to 2
  const r2 = cb.computeRebalance({
    equity: 100000, gross: 1, weights: { SPY: 0.5, TLT: 0.5 }, prices: { SPY: 100, TLT: 100 },
    positions: [{ symbol: 'TLT', market_value: 90000 }],   // TLT overweight → sell; SPY underweight → buy
  });
  assert.strictEqual(r2.orders[0].side, 'sell', 'sells first (frees buying power)');
});

// ── Conservative (no-margin) mode: maxGross caps leverage; deep-history research
//    (experiments/DEEP_HISTORY_RESEARCH_LOG.md) says the ≤1× cash-defensive book is the
//    best-Sharpe, lowest-drawdown, low-turnover profile — never borrow.
test('computeRebalance: maxGross caps the live brake gross (no-margin never borrows)', () => {
  // Brake asks for 1.8× but a no-margin book caps at 1.0×.
  const r = cb.computeRebalance({
    equity: 100000, gross: 1.8, maxGross: 1.0,
    weights: { SPY: 1 }, prices: { SPY: 100 }, positions: [],
  });
  assert.strictEqual(r.grossCap, 1.0, 'cap reported');
  assert.strictEqual(r.grossUsed, 1.0, '1.8x request clamped to the 1.0x no-margin cap');
  // SPY target = 100000 * 1.0 * 1 = 100,000 (not 180,000) → no leverage
  assert.strictEqual(r.targets.SPY, 100000);
});

test('computeRebalance: maxGross can only LOWER the ceiling, never exceed MAX_GROSS', () => {
  const r = cb.computeRebalance({ equity: 100000, gross: 5, maxGross: 9, weights: { SPY: 1 }, prices: { SPY: 100 }, positions: [] });
  assert.strictEqual(r.grossCap, cb.MAX_GROSS, 'maxGross=9 still clamped to the hard 2x ceiling');
  assert.strictEqual(r.grossUsed, cb.MAX_GROSS);
});

test('computeRebalance: no-margin de-risks toward cash on a storm gross (0.3x honored)', () => {
  // In a drawdown the brake sends gross to 0.3; no-margin must pass that through (de-risk).
  const r = cb.computeRebalance({
    equity: 100000, gross: 0.3, maxGross: 1.0,
    weights: { SPY: 1 }, prices: { SPY: 100 },
    positions: [{ symbol: 'SPY', market_value: 100000 }],   // fully invested → must sell down to 30k
  });
  assert.strictEqual(r.grossUsed, 0.3, 'de-risking gross passes through the cap');
  const spy = r.orders.find((o) => o.symbol === 'SPY');
  assert.ok(spy && spy.side === 'sell' && spy.notional === 70000, 'sells 70k to reach 30% invested');
});

test('computeRebalance: default maxGross is unchanged (2x still allowed, no behavior change)', () => {
  const r = cb.computeRebalance({ equity: 100000, gross: 2, weights: { SPY: 1 }, prices: { SPY: 100 }, positions: [] });
  assert.strictEqual(r.grossUsed, 2.0, 'standard book still permits the full 2x');
  assert.strictEqual(r.grossCap, cb.MAX_GROSS);
});
