// #3242 demo-mode — the guest Journal's simulated feed.
//
// Contract: journalRows() is deterministic within a day, produces ledger-shaped
// rows that flow through the SAME row-based builders as the real ledger, never
// claims to be real (source tag), and the demo book computes a coherent record
// (stats, daily curve, drawdown, skip groups).
//
// Run: node apps/lantern-garage/test/journal-demo.test.js
const assert = require('assert');
const { journalRows } = require('../lib/champion-demo');
const { buildBookFromRows } = require('../lib/track-record');
const { breakdownFromRows } = require('../lib/trader-scorecard');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

const a = journalRows();
const b = journalRows();

check('deterministic within a day', () => {
  assert.deepStrictEqual(a, b);
});

check('rows are ledger-shaped and honestly tagged as simulated', () => {
  assert.ok(a.exits.length >= 10, 'expected a populated demo window, got ' + a.exits.length);
  assert.ok(a.skips.length >= 10);
  for (const e of a.exits) {
    assert.strictEqual(e.event, 'exit');
    assert.strictEqual(e.source, 'champion-demo', 'every simulated row carries its source');
    assert.ok(Number.isFinite(e.pnl) && e.ts && e.symbol && e.reason);
    assert.ok(Number.isFinite(e.mfe_pct) && e.mfe_pct >= 0, 'MFE is non-negative');
    assert.ok(Number.isFinite(e.mae_pct) && e.mae_pct <= 0, 'MAE is non-positive');
  }
  for (const s of a.skips) assert.strictEqual(s.event, 'skip');
});

check('demo book flows through the real builders: stats, curve, drawdown cohere', () => {
  const book = buildBookFromRows(a.exits, { label: 'Demo book (simulated)' });
  assert.strictEqual(book.label, 'Demo book (simulated)');
  assert.strictEqual(book.stats.trades, a.exits.length, 'all demo rows are confirmed fills');
  assert.ok(book.daily.length > 5, 'multiple exchange days');
  const lastCum = book.daily[book.daily.length - 1].cum;
  assert.strictEqual(lastCum, book.stats.totalRealized, 'curve ends at total realized');
  assert.ok(book.maxDrawdown.amount >= 0);
  assert.ok(book.stats.excursions.nMfe === a.exits.length, 'MFE observed on every simulated row');
});

check('demo slices work: reasons carry the structural flag, skips group with counts', () => {
  const byReason = breakdownFromRows('reason', a.exits, null);
  assert.ok(byReason.confirmed.take_profit_R, 'profit-target family present');
  assert.strictEqual(byReason.confirmed.take_profit_R.profitOnly, true);
  assert.strictEqual(byReason.confirmed.stop.profitOnly, false);
  const skips = breakdownFromRows('skip', null, a.skips);
  assert.strictEqual(skips.totalSkips, a.skips.length);
  assert.ok(Object.keys(skips.groups).length >= 2, 'skip reasons normalize into families');
});

check('unknown slice still returns the typed error through the rows path', () => {
  const r = breakdownFromRows('nope', a.exits, a.skips);
  assert.strictEqual(r.error, 'unknown_breakdown');
});

process.exit(failures ? 1 : 0);
