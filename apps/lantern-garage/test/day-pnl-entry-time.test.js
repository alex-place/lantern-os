'use strict';
/**
 * day-pnl-entry-time.test.js — every open position reports WHEN it was opened
 * (founder, 2026-09-28: "we dont show the entry time anywhere, only position exits").
 *
 * day-pnl already had to read the entry rows — that is how it decides whether a
 * position's Day P&L is measured from your fill (opened today) or from yesterday's close
 * (carried). It kept only the ET date, in lastEntryDay, and discarded the clock time.
 *
 * So `entry_ts` is not a new source of truth: it is the timestamp of the SAME row that
 * decided `day_basis`, kept instead of thrown away. These tests pin that pairing, because
 * a position whose reported open time disagreed with the basis it was measured on would
 * be worse than no open time at all.
 *
 * Run: node --test apps/lantern-garage/test/day-pnl-entry-time.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeDayPnl, scanLedger } = require('../lib/day-pnl');

const row = (o) => JSON.stringify(o);
const quote = (ticker, price, prev) => ({ ticker, price, chg_pct: ((price - prev) / prev) * 100 });
const quoter = (list) => async (syms) => list.filter((q) => syms.includes(q.ticker));
const NOW = Date.parse('2026-08-18T15:55:00Z');          // Tue 11:55 ET, session live
const SMH = { symbol: 'SMH', qty: 203, current_price: 567.55, unrealized_pl: (567.55 - 575.22) * 203 };

const oneSym = (ledger) => computeDayPnl({
  positions: [SMH], ledgerText: ledger, now: NOW,
  getQuotes: quoter([quote('SMH', 567.55, 595.00)]),
});

test('a position opened today reports the time it was opened', async () => {
  const ts = '2026-08-18T13:30:00Z';                      // 09:30 ET
  const r = await oneSym(row({ ts, event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 }));
  assert.strictEqual(r.per_position[0].entry_ts, ts);
  assert.strictEqual(r.per_position[0].day_basis, 'entry', 'opened today measures from the fill');
});

test('a carried position reports its ORIGINAL open time, not today', async () => {
  // The whole point of the column: a lot you have held for days should say so.
  const ts = '2026-08-17T14:00:00Z';
  const r = await oneSym(row({ ts, event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 }));
  assert.strictEqual(r.per_position[0].entry_ts, ts);
  assert.strictEqual(r.per_position[0].day_basis, 'prev_close', 'carried measures from yesterday');
});

test('a lot the ledger never saw reports null — not a guessed time', async () => {
  // Same unknown-lot state that makes Day P&L fall back to the broker's since-entry
  // figure (#3353). The dashboard renders this as "not recorded".
  const r = await oneSym(row({ ts: '2026-08-18T13:40:00Z', event: 'skip', symbol: 'SMH', reason: 'no entry rows' }));
  assert.strictEqual(r.per_position[0].entry_ts, null);
  assert.strictEqual(r.per_position[0].day_basis, 'since_entry_unknown_lot');
});

test('an empty ledger reports null rather than omitting the field', async () => {
  // A missing key and a null read differently on the client: one is "old server",
  // the other is "no entry row". The field is always present.
  const r = await oneSym('');
  assert.ok('entry_ts' in r.per_position[0], 'entry_ts must always be present');
  assert.strictEqual(r.per_position[0].entry_ts, null);
});

test('re-entering the same symbol reports the LATEST entry', async () => {
  // Closed and re-opened the same day: the position you hold now was opened at 14:05,
  // and saying 09:30 would describe a lot that no longer exists.
  const ledger = [
    row({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 }),
    row({ ts: '2026-08-18T17:00:00Z', event: 'exit', symbol: 'SMH', qty: 203, exit: 570.00, pnl: -1059.06, status: 'filled' }),
    row({ ts: '2026-08-18T18:05:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 568.00 }),
  ].join('\n');
  const r = await oneSym(ledger);
  assert.strictEqual(r.per_position[0].entry_ts, '2026-08-18T18:05:00Z');
});

test('entry_ts and day_basis are decided by the SAME row', () => {
  // The invariant that makes the column trustworthy. scanLedger sets both in one branch,
  // so a symbol with a known entry day always has an entry time, and vice versa.
  const ledger = [
    row({ ts: '2026-08-17T14:00:00Z', event: 'entry', symbol: 'AAA', qty: 1, entry: 10 }),
    row({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'BBB', qty: 1, entry: 20 }),
    row({ ts: '2026-08-18T13:40:00Z', event: 'skip', symbol: 'CCC', reason: 'never entered' }),
  ].join('\n');
  const { lastEntryDay, lastEntryTs } = scanLedger(ledger, NOW);
  assert.deepStrictEqual([...lastEntryDay.keys()].sort(), [...lastEntryTs.keys()].sort(),
    'the two maps must cover exactly the same symbols');
  for (const [sym, ts] of lastEntryTs) {
    assert.ok(Number.isFinite(Date.parse(ts)), sym + ' has an unparseable entry time');
  }
  assert.strictEqual(lastEntryTs.get('CCC'), undefined, 'a symbol with no entry row has no entry time');
  assert.strictEqual(lastEntryTs.get('AAA'), '2026-08-17T14:00:00Z');
  assert.strictEqual(lastEntryTs.get('BBB'), '2026-08-18T13:30:00Z');
});

test('the attributed totals are untouched by carrying the timestamp', async () => {
  // This file adds a field to a calculation that has been corrected four times by live
  // mis-reports (#3283, #3353, #3380). None of those numbers may move.
  const ledger = row({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 });
  const r = await oneSym(ledger);
  assert.ok(Math.abs(r.unrealized_today - SMH.unrealized_pl) < 0.01,
    'opened today must still be measured since entry: got ' + r.unrealized_today);
  const carried = await oneSym(row({ ts: '2026-08-17T14:00:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 }));
  const todaysMove = (567.55 - 595.00) * 203;
  assert.ok(Math.abs(carried.unrealized_today - todaysMove) < 0.01,
    'carried must still be measured from prevClose: got ' + carried.unrealized_today);
});

// ── the column that renders it ───────────────────────────────────────────────────
// Three unknowns reach this cell and only one of them is about the ledger. Saying
// "no entry row in the trade ledger" on a box whose SERVER simply has not taken this
// change yet would be a lie about the reader's own data — and the race box is exactly
// that case, since it takes public files only.
const fs = require('node:fs');
const path = require('node:path');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const a = PAGE.indexOf('function ' + name + '(');
  assert.ok(a > 0, name + ' not found');
  return PAGE.slice(a, PAGE.indexOf('\n}\n', a) + 3);
};
const openedCell = new Function('_fmtOrderTime',
  grab('_tpHeldFor') + grab('_tpOpenedCell') + '\nreturn _tpOpenedCell;')(() => '10:30 AM');

test('a position with no open time is not blamed on the ledger when the SERVER is old', () => {
  const old = openedCell({ symbol: 'SPY' });                  // key absent entirely
  assert.match(old, /does not report open times yet/);
  assert.doesNotMatch(old, /entry row/, 'an old server is not a ledger gap');

  const unknownLot = openedCell({ symbol: 'SPY', entry_ts: null });   // key present, null
  assert.match(unknownLot, /not recorded/);
  assert.match(unknownLot, /No entry row for this symbol/, 'a real unknown lot says which it is');

  assert.notStrictEqual(old, unknownLot, 'the two unknowns must not render identically');
});

test('a position with an open time shows it, with how long it has been held', () => {
  const html = openedCell({ symbol: 'SPY', entry_ts: new Date(Date.now() - 95 * 60000).toISOString() });
  assert.match(html, /10:30 AM/, 'the ET time');
  assert.match(html, /1h 35m/, 'and the hold beside it');
  assert.match(html, /title="Opened /, 'with the full timestamp on hover');
});

test('the hold reads as time, and an impossible one is absent rather than zero', () => {
  const held = new Function(grab('_tpHeldFor') + '\nreturn _tpHeldFor;')();
  assert.strictEqual(held(45 * 60000), '45m');
  assert.strictEqual(held(2 * 3600000), '2h');
  assert.strictEqual(held(3.5 * 3600000), '3h 30m');
  assert.strictEqual(held(50 * 3600000), '2d 2h');
  assert.strictEqual(held(0), null);
  assert.strictEqual(held(-5), null, 'a position held backwards in time is a broken record');
});
