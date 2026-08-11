// #3246 — the public, settlement-graded track-record snapshot.
//
// The contract under test: confirmed fills ONLY (decisions/dry-runs never enter the
// public artifact), the daily curve + max drawdown are computed on ET days, every
// exclusion is disclosed as a count, the Champion book is honestly `pending`, and
// the build is deterministic from the same ledger. Fixture-driven.
//
// Run: node apps/lantern-garage/test/track-record.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildTrackRecord, snapshotPathFor } = require('../lib/track-record');

const FIXTURE = path.join(__dirname, 'tmp-track-record-fixture.jsonl');

// Three ET days engineered for a known curve: +100 → −40 → +10  ⇒ cum 100, 60, 70
// ⇒ max drawdown 40 (peak 08-03 → trough 08-04).
const rows = [
  { ts: '2026-08-03T14:30:00.000Z', event: 'exit', symbol: 'SPY', qty: 10, entry: 100, pnl: 100, pnl_pct: 1, reason: 'zone_r1', status: 'filled' },
  { ts: '2026-08-04T14:30:00.000Z', event: 'exit', symbol: 'QQQ', qty: 5, entry: 200, pnl: -40, pnl_pct: -0.4, reason: 'stop', status: 'placed' },
  { ts: '2026-08-05T14:30:00.000Z', event: 'exit', symbol: 'IWM', qty: 7, entry: 50, pnl: 10, pnl_pct: 0.1, reason: 'take_profit_R', status: 'filled' },
  // dry-run decision — must NOT enter the public record at all
  { ts: '2026-08-05T15:00:00.000Z', event: 'exit', symbol: 'TNA', qty: 3, entry: 30, pnl: 5000, pnl_pct: 50, reason: 'signal_exit', status: 'dry_run' },
  // broker-rejected attempt — realized nothing; excluded AND disclosed
  { ts: '2026-08-05T15:10:00.000Z', event: 'exit', symbol: 'SPY', qty: 2, entry: 99, pnl: 999, pnl_pct: 9, reason: 'signal_exit', status: 'rejected' },
];

fs.writeFileSync(FIXTURE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

const snap = buildTrackRecord(FIXTURE);
const book = snap.books.intraday;

check('the artifact is confirmed-fills-only, and says so', () => {
  assert.strictEqual(snap.confirmedOnly, true);
  assert.strictEqual(book.stats.trades, 3, 'dry_run and rejected must not be counted');
  assert.strictEqual(book.stats.totalRealized, 70);
});

check('daily curve: ET days, cumulative math', () => {
  assert.deepStrictEqual(book.daily.map((d) => d.date), ['2026-08-03', '2026-08-04', '2026-08-05']);
  assert.deepStrictEqual(book.daily.map((d) => d.cum), [100, 60, 70]);
});

check('max drawdown is on the cumulative curve, with its dates', () => {
  assert.strictEqual(book.maxDrawdown.amount, 40);
  assert.strictEqual(book.maxDrawdown.peakDate, '2026-08-03');
  assert.strictEqual(book.maxDrawdown.troughDate, '2026-08-04');
});

check('exclusions are disclosed, not silent', () => {
  assert.strictEqual(book.disclosures.failedAttemptsExcluded, 1, 'the rejected attempt is disclosed');
});

check('the Champion book is honestly pending — no estimated record', () => {
  assert.strictEqual(snap.books.champion.status, 'pending');
  assert.ok(!snap.books.champion.stats, 'pending book publishes NO numbers');
});

check('no public-unsafe fields leak into the snapshot', () => {
  const s = JSON.stringify(snap);
  assert.ok(!/"qty"/.test(s), 'share quantities must not appear');
  assert.ok(!/order_id|orderId/.test(s), 'order ids must not appear');
});

check('deterministic: same ledger → same snapshot (modulo generatedAt)', () => {
  const a = { ...buildTrackRecord(FIXTURE), generatedAt: 'x' };
  const b = { ...buildTrackRecord(FIXTURE), generatedAt: 'x' };
  assert.deepStrictEqual(a, b);
});

check('empty ledger → explicit no_confirmed_trades state, zeroed stats', () => {
  const EMPTY = FIXTURE + '.empty';
  fs.writeFileSync(EMPTY, '');
  const e = buildTrackRecord(EMPTY);
  assert.strictEqual(e.books.intraday.status, 'no_confirmed_trades');
  assert.strictEqual(e.books.intraday.stats.trades, 0);
  fs.unlinkSync(EMPTY);
});

check('snapshot path sits next to the ledger', () => {
  assert.strictEqual(path.basename(snapshotPathFor(FIXTURE)), 'track-record-snapshot.json');
  assert.strictEqual(path.dirname(snapshotPathFor(FIXTURE)), path.dirname(FIXTURE));
});

fs.unlinkSync(FIXTURE);
process.exit(failures ? 1 : 0);
