'use strict';

/**
 * Tests for lib/edge-score-ledger.js (#3259) — the equity edge-score prediction ledger,
 * settlement, and calibration. Everything is deterministic and hand-computable: a synthetic
 * ledger with known outcomes must produce the exact Brier / decile figures.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../lib/edge-score-ledger');

// ── schema ───────────────────────────────────────────────────────────────────────────────────
test('makeRow normalizes + validates a prediction', () => {
  const r = L.makeRow({ symbol: 'aapl', score: 1.4, date: '2026-01-02T09:30:00Z', horizonDays: 5.6, components: { mom: 0.3 } });
  assert.strictEqual(r.symbol, 'AAPL');
  assert.strictEqual(r.score, 1, 'score clamps into [0,1]');
  assert.strictEqual(r.date, '2026-01-02', 'date truncates to YYYY-MM-DD');
  assert.strictEqual(r.horizonDays, 6, 'horizon rounds to an integer');
  assert.strictEqual(r.benchmark, 'SPY', 'benchmark defaults to SPY');
  assert.strictEqual(r.settled, false);
  assert.strictEqual(r.outcome, null);
  assert.deepStrictEqual(r.components, { mom: 0.3 });
});

test('makeRow rejects malformed predictions', () => {
  assert.throws(() => L.makeRow({ score: 0.5 }), /symbol/);
  assert.throws(() => L.makeRow({ symbol: 'X' }), /numeric score/);
  assert.throws(() => L.makeRow({ symbol: 'X', score: 'abc' }), /numeric score/);
});

// ── I/O roundtrip ────────────────────────────────────────────────────────────────────────────
test('appendPrediction + readLedger roundtrip', async () => {
  const file = path.join(os.tmpdir(), `edge-ledger-${process.pid}-${Date.now()}.jsonl`);
  try {
    await L.appendPrediction({ symbol: 'AAA', score: 0.7, date: '2026-01-01', horizonDays: 5 }, { file });
    await L.appendPrediction({ symbol: 'BBB', score: 0.3, date: '2026-01-01', horizonDays: 5 }, { file });
    const rows = L.readLedger({ file });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].symbol, 'AAA');
    assert.strictEqual(rows[1].score, 0.3);
    // tolerant of a torn trailing line
    fs.appendFileSync(file, '{ not json\n');
    assert.strictEqual(L.readLedger({ file }).length, 2, 'a torn line is skipped, not thrown');
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('readLedger returns [] for a missing file', () => {
  assert.deepStrictEqual(L.readLedger({ file: path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl') }), []);
});

// ── date + maturity ──────────────────────────────────────────────────────────────────────────
test('addDays + isMatured', () => {
  assert.strictEqual(L.addDays('2026-01-01', 5), '2026-01-06');
  assert.strictEqual(L.addDays('2026-02-27', 2), '2026-03-01', 'crosses month boundary (2026 not leap)');
  const row = { date: '2026-01-01', horizonDays: 5 };
  assert.strictEqual(L.isMatured(row, '2026-01-06'), true, 'matures exactly at date+horizon');
  assert.strictEqual(L.isMatured(row, '2026-01-05'), false);
});

// ── settlement ───────────────────────────────────────────────────────────────────────────────
test('barsResolver grades symbol-beats-benchmark over the horizon window', () => {
  const bars = {
    AAA: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 110 }], // +10%
    BBB: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 102 }], // +2%
    SPY: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 105 }], // +5%
  };
  const resolve = L.barsResolver(bars);
  const win = resolve({ symbol: 'AAA', benchmark: 'SPY', date: '2026-01-01', horizonDays: 5 });
  assert.strictEqual(win.outcome, 1, 'AAA +10% beats SPY +5%');
  assert.strictEqual(win.symbolReturn, 0.1);
  assert.strictEqual(win.benchmarkReturn, 0.05);
  const lose = resolve({ symbol: 'BBB', benchmark: 'SPY', date: '2026-01-01', horizonDays: 5 });
  assert.strictEqual(lose.outcome, 0, 'BBB +2% loses to SPY +5%');
  // missing bars -> null (leave open)
  assert.strictEqual(resolve({ symbol: 'ZZZ', benchmark: 'SPY', date: '2026-01-01', horizonDays: 5 }), null);
});

test('settle gates on maturity, does not mutate input, leaves ungradeable rows open', () => {
  const bars = {
    AAA: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 110 }],
    SPY: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 105 }],
  };
  const rows = [
    L.makeRow({ symbol: 'AAA', score: 0.8, date: '2026-01-01', horizonDays: 5 }),
    L.makeRow({ symbol: 'ZZZ', score: 0.6, date: '2026-01-01', horizonDays: 5 }), // no bars
  ];

  // Before maturity: nothing settles.
  const early = L.settle(rows, L.barsResolver(bars), { asOf: '2026-01-03' });
  assert.strictEqual(early.settledCount, 0);
  assert.strictEqual(early.openCount, 2);

  // At/after maturity: AAA settles, ZZZ stays open (no bars).
  const done = L.settle(rows, L.barsResolver(bars), { asOf: '2026-01-10' });
  assert.strictEqual(done.settledCount, 1);
  assert.strictEqual(done.openCount, 1);
  const aaa = done.rows.find((r) => r.symbol === 'AAA');
  assert.strictEqual(aaa.settled, true);
  assert.strictEqual(aaa.outcome, 1);
  assert.strictEqual(aaa.settledAt, '2026-01-10');

  // Input rows are untouched (append-only / replayable invariant).
  assert.strictEqual(rows[0].settled, false, 'settle must not mutate the input row');
  assert.strictEqual(rows[0].outcome, null);
});

// ── calibration: exact, hand-computed ──────────────────────────────────────────────────────────
function settledRow(score, outcome) {
  return { settled: true, score, outcome, symbol: 'X' };
}

test('Brier score + skill score are exact', () => {
  // ((0.1-0)^2 + (0.9-1)^2)/2 = (0.01 + 0.01)/2 = 0.01
  const cal = L.computeCalibration([settledRow(0.1, 0), settledRow(0.9, 1)], { now: 'T' });
  assert.strictEqual(cal.n, 2);
  assert.strictEqual(cal.brier, 0.01);
  assert.strictEqual(cal.baseRate, 0.5);
  // BSS = 1 - 0.01/(0.5*0.5) = 0.96
  assert.strictEqual(cal.brierSkillScore, 0.96);

  // Perfect forecasts -> Brier 0, BSS 1.
  const perfect = L.computeCalibration([settledRow(0, 0), settledRow(1, 1)]);
  assert.strictEqual(perfect.brier, 0);
  assert.strictEqual(perfect.brierSkillScore, 1);

  // Coin-flip forecasts on a 50/50 base -> Brier 0.25, BSS 0.
  const coin = L.computeCalibration([settledRow(0.5, 0), settledRow(0.5, 1)]);
  assert.strictEqual(coin.brier, 0.25);
  assert.strictEqual(coin.brierSkillScore, 0);
});

test('equal-count decile hit rates line up with a monotone score', () => {
  // 20 settled rows: score = i/20 (0..0.95), outcome = score >= 0.5.
  const rows = [];
  for (let i = 0; i < 20; i++) { const s = i / 20; rows.push(settledRow(s, s >= 0.5 ? 1 : 0)); }
  const cal = L.computeCalibration(rows, { nDeciles: 10 });
  assert.strictEqual(cal.n, 20);
  assert.strictEqual(cal.deciles.length, 10);
  for (const d of cal.deciles) assert.strictEqual(d.n, 2, 'equal-count: 20/10 = 2 per decile');
  // bottom 5 deciles are all-miss, top 5 all-hit
  for (let i = 0; i < 5; i++) assert.strictEqual(cal.deciles[i].hitRate, 0, `decile ${i + 1} should be 0`);
  for (let i = 5; i < 10; i++) assert.strictEqual(cal.deciles[i].hitRate, 1, `decile ${i + 1} should be 1`);
  assert.strictEqual(cal.baseRate, 0.5);
});

test('reliability table bins predicted vs observed and conserves n', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) { const s = i / 20; rows.push(settledRow(s, s >= 0.5 ? 1 : 0)); }
  const cal = L.computeCalibration(rows, { nBins: 10 });
  const totalN = cal.reliability.reduce((s, b) => s + b.n, 0);
  assert.strictEqual(totalN, 20, 'every settled pair lands in exactly one bin');
  for (const b of cal.reliability) {
    assert.ok(b.observed >= 0 && b.observed <= 1);
    assert.ok(b.range[0] < b.range[1]);
  }
});

test('empty / all-open ledger yields a null-but-safe summary', () => {
  const cal = L.computeCalibration([{ settled: false, score: 0.5, outcome: null }]);
  assert.strictEqual(cal.n, 0);
  assert.strictEqual(cal.brier, null);
  assert.strictEqual(cal.baseRate, null);
  assert.strictEqual(cal.brierSkillScore, null);
  assert.deepStrictEqual(cal.deciles, []);
});

// ── end-to-end settlement job ──────────────────────────────────────────────────────────────────
test('runSettlement reads, grades, and computes calibration (no artifact write)', () => {
  const file = path.join(os.tmpdir(), `edge-run-${process.pid}-${Date.now()}.jsonl`);
  try {
    const rows = [
      L.makeRow({ symbol: 'AAA', score: 0.8, date: '2026-01-01', horizonDays: 5 }),
      L.makeRow({ symbol: 'BBB', score: 0.2, date: '2026-01-01', horizonDays: 5 }),
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const bars = {
      AAA: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 112 }], // +12% beats SPY
      BBB: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 101 }], // +1% loses to SPY
      SPY: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-06', close: 105 }], // +5%
    };
    const { summary, settledCount, openCount } = L.runSettlement({ file, barsBySymbol: bars, asOf: '2026-01-10', write: false });
    assert.strictEqual(settledCount, 2);
    assert.strictEqual(openCount, 0);
    assert.strictEqual(summary.n, 2);
    // AAA (score .8) beat -> outcome 1; BBB (score .2) lost -> outcome 0. Both well-calibrated:
    // Brier = ((0.8-1)^2 + (0.2-0)^2)/2 = (0.04 + 0.04)/2 = 0.04
    assert.strictEqual(summary.brier, 0.04);
    assert.strictEqual(summary.baseRate, 0.5);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});
