'use strict';
/**
 * walk-forward.test.js — the IS-WFA-OOS harness (#2582).
 *
 * The harness's ONE job is that the number it reports came from data the optimizer never saw.
 * These tests pin that with a deterministic toy strategy whose in-sample choice and out-of-sample
 * outcome are both hand-computable, so a regression that leaks IS into OOS (or mis-tiles the
 * folds) fails loudly rather than quietly inflating a backtest.
 *
 * Zero-dep — run with:  node --test experiments/lib/walk-forward.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { walkForward, makeFolds, metrics, evalGates, DEFAULT_GATES } = require('./walk-forward');

// Toy strategy: each bar (a number) becomes one trade whose return is sign*bar. Optimizing
// `sign` over {+1,-1} on an IS window picks whichever sign made the IS window profitable — a
// pure directional bet whose IS choice and OOS payoff are both obvious by inspection.
const simulate = (bars, { sign }) => bars.map((b) => ({ retPct: sign * b }));
const grid = [{ sign: 1 }, { sign: -1 }];
const scoreByExpectancy = (m) => m.expectancyPct;

// ── fold construction ─────────────────────────────────────────────────────────

test('rolling folds tile the OOS space with no overlap and no gaps', () => {
  const folds = makeFolds(100, 40, 20, false);
  assert.equal(folds.length, 3); // oosStart 40,60,80 → 80+20=100 ok; 100+20>100 stops
  for (const f of folds) assert.equal(f.isEnd - f.isStart, 40, 'rolling IS is fixed width');
  // OOS segments are contiguous and non-overlapping
  assert.deepEqual(folds.map((f) => [f.oosStart, f.oosEnd]), [[40, 60], [60, 80], [80, 100]]);
});

test('anchored folds grow the IS window from 0 while OOS still marches forward', () => {
  const folds = makeFolds(100, 40, 20, true);
  assert.deepEqual(folds.map((f) => f.isStart), [0, 0, 0]);
  assert.deepEqual(folds.map((f) => f.isEnd), [40, 60, 80]);
  assert.deepEqual(folds.map((f) => [f.oosStart, f.oosEnd]), [[40, 60], [60, 80], [80, 100]]);
});

test('every OOS segment is strictly AFTER the IS window it was validated against', () => {
  for (const anchored of [true, false]) {
    for (const f of makeFolds(200, 50, 25, anchored)) {
      assert.ok(f.oosStart >= f.isEnd, `no look-ahead: OOS[${f.oosStart}] must start at/after IS end[${f.isEnd}]`);
    }
  }
});

// ── optimize-on-IS, evaluate-on-OOS ───────────────────────────────────────────

test('the sign chosen on IS is the one that was profitable IN SAMPLE, then applied to OOS', () => {
  // IS window (first 4 bars) trends UP → optimizer must pick sign=+1; OOS (next 2) also up → wins.
  const bars = [1, 2, 1, 2, /* oos */ 3, 3];
  const r = walkForward({ bars, grid, simulate, score: scoreByExpectancy, isBars: 4, oosBars: 2, anchored: true });
  assert.equal(r.folds.length, 1);
  assert.deepEqual(r.folds[0].chosenParams, { sign: 1 });
  assert.ok(r.oos.expectancyPct > 0, 'OOS with the IS-chosen long sign is profitable');
});

test('an edge that holds in IS but inverts in OOS is caught: negative WFE, gate fails', () => {
  // One clean fold: IS (6 bars) trends UP so the optimizer picks long; the OOS regime then
  // flips DOWN, so the fitted long loses. Single fold keeps the outcome hand-computable — a
  // rolling window would (correctly) re-pick short on a net-down IS, which is the harness
  // adapting, not the failure mode this test isolates.
  const bars = [1, 1, 1, 1, 1, 1, /* oos */ -2, -2];
  const r = walkForward({ bars, grid, simulate, score: scoreByExpectancy, isBars: 6, oosBars: 2, anchored: true });
  assert.equal(r.folds.length, 1);
  assert.deepEqual(r.folds[0].chosenParams, { sign: 1 }, 'IS uptrend → long');
  assert.ok(r.oos.expectancyPct < 0, 'OOS is a loss — the edge did not survive');
  assert.ok(r.folds[0].wfe < 0, 'walk-forward efficiency inverted (OOS score < 0 while IS > 0)');
  // The inversion is caught by the OOS profit-factor gate regardless of fold count.
  const pf = r.gate.checks.find((c) => c.name === 'oosProfitFactor');
  assert.equal(pf.pass, false, 'a losing OOS record fails the profit-factor gate');
  assert.equal(r.gate.pass, false);
});

test('a genuinely robust directional edge passes the gate', () => {
  // consistent uptrend everywhere → long is right in every IS and holds in every OOS
  const bars = Array.from({ length: 120 }, (_, i) => 1 + (i % 3));  // all positive
  const r = walkForward({ bars, grid, simulate, score: scoreByExpectancy, isBars: 40, oosBars: 20, anchored: true });
  assert.ok(r.folds.length >= DEFAULT_GATES.minFolds);
  assert.ok(r.oos.expectancyPct > 0);
  assert.equal(r.wfe.positiveOosFraction, 1, 'edge shows in every fold');
  assert.equal(r.gate.pass, true);
});

// ── the OOS track record is concatenated OOS ONLY, never IS ────────────────────

test('reported OOS trade count equals the total OOS bars, not the whole series', () => {
  const bars = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1));
  const r = walkForward({ bars, grid, simulate, score: scoreByExpectancy, isBars: 40, oosBars: 20, anchored: false });
  // 3 folds × 20 OOS bars = 60 OOS trades (the other 40+ IS bars are NOT in the track record)
  assert.equal(r.oos.n, r.folds.length * 20);
  assert.ok(r.oos.n < bars.length, 'OOS record is a strict subset of the series');
});

// ── metrics + gates units ──────────────────────────────────────────────────────

test('metrics is empty-safe and computes profit factor honestly', () => {
  assert.equal(metrics([]).n, 0);
  const m = metrics([{ retPct: 0.02 }, { retPct: -0.01 }, { retPct: 0.03 }]);
  assert.equal(m.n, 3);
  assert.ok(Math.abs(m.profitFactor - 5) < 1e-9);        // (0.02+0.03)/0.01
  assert.equal(metrics([{ retPct: 0.01 }]).profitFactor, Infinity);  // no losses
});

test('evalGates fails closed when a single pre-committed check misses', () => {
  const base = { folds: [1, 2, 3, 4], oos: { profitFactor: 2, maxDDpct: -5 },
    wfe: { avg: 0.9, positiveOosFraction: 0.8 } };
  assert.equal(evalGates(base, DEFAULT_GATES).pass, true);
  const badWfe = evalGates({ ...base, wfe: { avg: 0.2, positiveOosFraction: 0.8 } }, DEFAULT_GATES);
  assert.equal(badWfe.pass, false);
  assert.ok(badWfe.checks.find((c) => c.name === 'avgWFE').pass === false);
});
