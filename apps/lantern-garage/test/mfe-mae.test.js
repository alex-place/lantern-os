// #3241 — MFE/MAE capture on exit rows.
//
// Contract: excursion fields are pure math from (entry, peak, trough, stop
// distance), NULL — never zero — when the run wasn't observed; fill rows carry
// them through the entryFor() context; and the scorecard averages only over rows
// that have them (historical rows without the fields stay out of the denominator).
//
// Run: node apps/lantern-garage/test/mfe-mae.test.js
const assert = require('assert');
const { excursionFields, newExitRows } = require('../lib/fill-ledger');
const { computeScorecard } = require('../lib/trader-scorecard');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

check('excursionFields: happy path — % of entry, R from stop distance', () => {
  const f = excursionFields(100, 106, 98.5, 2);
  assert.strictEqual(f.mfe_pct, 6);
  assert.strictEqual(f.mae_pct, -1.5);
  assert.strictEqual(f.mfe_r, 3);
  assert.strictEqual(f.mae_r, -0.75);
});

check('excursionFields: unobserved run → null, never zero', () => {
  const f = excursionFields(100, undefined, undefined, 2);
  assert.deepStrictEqual(f, { mfe_pct: null, mae_pct: null, mfe_r: null, mae_r: null });
  const g = excursionFields(0, 106, 98, 2);   // no entry price → nothing computable
  assert.deepStrictEqual(g, { mfe_pct: null, mae_pct: null, mfe_r: null, mae_r: null });
});

check('excursionFields: peak below entry / trough above entry clamp to 0, not negative-favorable', () => {
  const f = excursionFields(100, 99, 101, 2);  // never went our way, never went against us
  assert.strictEqual(f.mfe_pct, 0);
  assert.strictEqual(f.mae_pct, 0);
});

check('excursionFields: no stop distance → % present, R null', () => {
  const f = excursionFields(100, 103, 99, null);
  assert.strictEqual(f.mfe_pct, 3);
  assert.strictEqual(f.mae_r, null);
});

check('newExitRows: fill rows carry the excursions passed via entryFor()', () => {
  const orders = [{ orderId: '77', symbol: 'SPY', side: 'SELL', status: 'Filled', filledQty: 10, avgPrice: 104 }];
  const rows = newExitRows(orders, new Set(), () => ({ avg_entry_price: 100, reason: 'take_profit_R', peak: 105, trough: 99, stopDistPct: 2 }), 0);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].mfe_pct, 5);
  assert.strictEqual(rows[0].mae_pct, -1);
  assert.strictEqual(rows[0].mfe_r, 2.5);
});

check('scorecard: averages only over rows that observed their run; null when none did', () => {
  const withEx = computeScorecard([
    { symbol: 'A', pnl: 10, reason: 'stop', status: 'filled', mfe_pct: 4, mae_pct: -2 },
    { symbol: 'B', pnl: -5, reason: 'stop', status: 'filled', mfe_pct: 2, mae_pct: -4 },
    { symbol: 'C', pnl: 3, reason: 'stop', status: 'filled' },              // historical row, no fields
  ]);
  assert.strictEqual(withEx.excursions.nMfe, 2, 'the unobserved row stays out of the denominator');
  assert.strictEqual(withEx.excursions.avgMfePct, 3);
  assert.strictEqual(withEx.excursions.avgMaePct, -3);
  const without = computeScorecard([{ symbol: 'A', pnl: 10, reason: 'stop', status: 'filled' }]);
  assert.strictEqual(without.excursions.avgMfePct, null, 'null, never 0, when nothing observed');
  assert.strictEqual(without.excursions.nMfe, 0);
});

process.exit(failures ? 1 : 0);
