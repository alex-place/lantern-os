'use strict';
/**
 * scorecard-extra-ledgers.test.js — the journal reads every ledger that trades the
 * account (2026-09-28).
 *
 * The scorecard and the track record are built from the exit ledger. The two-sleeve
 * engine journals each sleeve to its own file and the server on the account's port
 * trades nothing, so from the day the engine took over that server's journal page
 * stopped moving: "Realized results, 2026-08-20 to 2026-09-22, 50 closed trades"
 * while sixteen more closed trades sat in the engine's journals.
 *
 * TRADER_TRADES_LOG_EXTRA names the other ledgers. These pin: unset = unchanged; a
 * named path is read alone; rows merge in time order; a fill journaled in two files
 * counts once; repeats inside one file are left to dedupeRoundTrips; user scoping
 * still applies; and the track record sees the same merged book.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-extra-'));
const PRIMARY = path.join(DIR, 'autopilot-trades.jsonl');
const S = path.join(DIR, 'S.autopilot-trades.jsonl');
const R = path.join(DIR, 'R.autopilot-trades.jsonl');
process.env.TRADER_TRADES_LOG = PRIMARY;          // DEFAULT_LOG is fixed when the module loads
delete process.env.TRADER_TRADES_LOG_EXTRA;
const sc = require('../lib/trader-scorecard');
const tr = require('../lib/track-record');

const row = (o) => JSON.stringify(o);
const exit = (ts, symbol, pnl, extra) => ({ ts, event: 'exit', symbol, qty: 10, entry: 100, exit: 100 + pnl / 10, pnl, pnl_pct: pnl / 10, reason: 'signal_exit', status: 'filled', ...extra });

// the server's own ledger: it stopped trading on the 22nd
fs.writeFileSync(PRIMARY, [
  row(exit('2026-09-21T15:00:00.000Z', 'SPY', -40, { order_id: 'p-1', user: 'local-owner' })),
  row(exit('2026-09-22T15:00:00.000Z', 'QQQ', -60, { order_id: 'p-2', user: 'local-owner', entry: 101 })),
  row({ ts: '2026-09-22T15:01:00.000Z', event: 'skip', symbol: 'GLD', reason: 'bearish, no long to exit' }),
].join('\n') + '\n');
// the engine's sleeves: S stamps the user, R (an older brain) does not
fs.writeFileSync(S, [
  row(exit('2026-09-28T16:28:04.000Z', 'TLT', 31.45, { order_id: 's-1', user: 'local-owner', entry: 78.39 })),
  row(exit('2026-09-24T17:00:00.000Z', 'SMH', 120, { order_id: 's-0', user: 'local-owner', entry: 590 })),
  row(exit('2026-09-22T15:00:00.000Z', 'QQQ', -60, { order_id: 'p-2', user: 'local-owner', entry: 101 })),   // the same fill, journaled twice
  row({ ts: '2026-09-28T15:00:00.000Z', event: 'skip', symbol: 'DIA', reason: 'entry_confirm' }),
].join('\n') + '\n');
fs.writeFileSync(R, [
  row(exit('2026-09-28T13:31:00.000Z', 'GLD', -79.91, { order_id: 'r-1', entry: 392.79, qty: 6, order_type: 'stop' })),
  row(exit('2026-09-25T14:00:00.000Z', 'IWM', -20, { order_id: 'r-0', entry: 240, user: 'someone-else' })),
].join('\n') + '\n');

const withExtra = (value, fn) => {
  const old = process.env.TRADER_TRADES_LOG_EXTRA;
  if (value == null) delete process.env.TRADER_TRADES_LOG_EXTRA; else process.env.TRADER_TRADES_LOG_EXTRA = value;
  try { return fn(); } finally { if (old == null) delete process.env.TRADER_TRADES_LOG_EXTRA; else process.env.TRADER_TRADES_LOG_EXTRA = old; tr._resetCache(); }
};
const ids = (rows) => rows.map((r) => r.order_id);

test('unset: the default ledger alone, exactly as before', () => {
  withExtra(null, () => {
    assert.deepStrictEqual(sc.extraLogsFor(sc.DEFAULT_LOG), []);
    assert.deepStrictEqual(ids(sc.readExits()), ['p-1', 'p-2']);
    assert.strictEqual(sc.scorecard().confirmed.totalRealized, -100);
  });
});

test('extras: one book, in time order, a fill journaled twice counted once', () => {
  withExtra(`${S} ; ${R};${PRIMARY}`, () => {
    assert.deepStrictEqual(sc.extraLogsFor(sc.DEFAULT_LOG), [path.resolve(S), path.resolve(R)], 'the default ledger is not its own extra');
    const rows = sc.readExits();
    assert.deepStrictEqual(ids(rows), ['p-1', 'p-2', 's-0', 'r-0', 'r-1', 's-1'], 'chronological across files; p-2 once');
    const card = sc.scorecard();
    assert.strictEqual(card.confirmed.trades, 6);
    assert.strictEqual(card.confirmed.totalRealized, -48.46, '-40 -60 +120 -20 -79.91 +31.45');
    assert.deepStrictEqual(sc.readEvents('skip').map((r) => r.symbol), ['GLD', 'DIA'], 'every event type reads the merged book');
  });
});

test('a caller that names a ledger reads that ledger alone', () => {
  withExtra(`${S};${R}`, () => {
    assert.deepStrictEqual(ids(sc.readExits(S)), ['s-1', 's-0', 'p-2'], 'file order, no merge, no re-sort');
    assert.deepStrictEqual(sc.extraLogsFor(S), []);
    assert.strictEqual(sc.scorecard(R).confirmed.trades, 2);
  });
});

test('rows that repeat inside ONE file are left to dedupeRoundTrips', () => {
  const twice = path.join(DIR, 'twice.jsonl');
  const again = exit('2026-09-28T18:00:00.000Z', 'UCO', 14.5, { user: 'local-owner', entry: 52.3 });   // no order id: a re-decision
  fs.writeFileSync(twice, [row(again), row(again)].join('\n') + '\n');
  withExtra(twice, () => {
    const rows = sc.readExits().filter((r) => r.symbol === 'UCO');
    assert.strictEqual(rows.length, 2, 'the reader does not second-guess one file');
    assert.strictEqual(sc.scorecard().confirmed.duplicateExits, 1, 'the round-trip rule collapses them, and says so');
  });
});

test('user scoping still applies: unstamped rows are the house book, a stranger sees only their own', () => {
  withExtra(`${S};${R}`, () => {
    assert.deepStrictEqual(ids(sc.readExits(undefined, 'local-owner')), ['p-1', 'p-2', 's-0', 'r-1', 's-1']);
    assert.deepStrictEqual(ids(sc.readExits(undefined, 'someone-else')), ['r-0']);
  });
});

test('an unreadable extra contributes nothing and breaks nothing', () => {
  withExtra(`${path.join(DIR, 'nope.jsonl')};${S}`, () => {
    assert.deepStrictEqual(ids(sc.readExits()), ['p-1', 'p-2', 's-0', 's-1']);
  });
});

test('a fill booked by two ledgers keeps the row that names a real lot (live 2026-09-25, TLT)', () => {
  const P = path.join(DIR, 'tlt-primary.jsonl');
  const s2 = path.join(DIR, 'tlt-S.jsonl');
  const r2 = path.join(DIR, 'tlt-R.jsonl');
  // the account bought 46 TLT at 81.62 on the 22nd; a stop sold them at 79.16 on the 25th
  fs.writeFileSync(P, row({ ts: '2026-09-22T16:07:00.000Z', event: 'entry', symbol: 'TLT', qty: 46, entry: 81.62 }) + '\n');
  // the sleeve that did NOT own the lot booked the fill too, against a price nobody had paid yet
  fs.writeFileSync(s2, [
    row(exit('2026-09-25T14:00:15.000Z', 'TLT', 8.32, { order_id: '29e09ee7', qty: 46, entry: 78.98, exit: 79.16087, reason: 'broker fill', user: 'local-owner' })),
    row({ ts: '2026-09-25T15:17:57.000Z', event: 'entry', symbol: 'TLT', qty: 25, entry: 78.975 }),   // AFTER the fill: cannot be its lot
  ].join('\n') + '\n');
  fs.writeFileSync(r2, row(exit('2026-09-25T14:00:15.000Z', 'TLT', -113.12, { order_id: '29e09ee7', qty: 46, entry: 81.62, exit: 79.16087, reason: 'broker fill' })) + '\n');
  const old = process.env.TRADER_TRADES_LOG_EXTRA;
  // a separate module instance whose DEFAULT ledger is this fixture
  const file = require.resolve('../lib/trader-scorecard');
  const saved = require.cache[file];
  delete require.cache[file];
  const prevLog = process.env.TRADER_TRADES_LOG;
  process.env.TRADER_TRADES_LOG = P;
  try {
    const sc2 = require('../lib/trader-scorecard');
    process.env.TRADER_TRADES_LOG_EXTRA = `${s2};${r2}`;
    const rows = sc2.readExits();
    assert.strictEqual(rows.length, 1, 'one broker order, one row');
    assert.strictEqual(rows[0].pnl, -113.12, 'the row whose entry matches the buy at 81.62');
    assert.deepStrictEqual(rows.ledgers, { extras: 2, duplicateFills: 1, corrected: 1 });
    const card = sc2.scorecard();
    assert.strictEqual(card.confirmed.totalRealized, -113.12);
    assert.deepStrictEqual(card.ledgers, { extras: 2, duplicateFills: 1, corrected: 1 }, 'the scorecard says what it merged');
    // the other order of files gives the same answer: the rule is about the lot, not the reading order
    process.env.TRADER_TRADES_LOG_EXTRA = `${r2};${s2}`;
    assert.strictEqual(sc2.readExits()[0].pnl, -113.12);
  } finally {
    process.env.TRADER_TRADES_LOG = prevLog;
    if (old == null) delete process.env.TRADER_TRADES_LOG_EXTRA; else process.env.TRADER_TRADES_LOG_EXTRA = old;
    delete require.cache[file];
    if (saved) require.cache[file] = saved;
  }
});

test('the track record is built from the same merged book', () => {
  const alone = withExtra(null, () => tr.buildTrackRecord());
  const merged = withExtra(`${S};${R}`, () => tr.buildTrackRecord());
  const n = (snap) => snap.books.intraday.trades != null ? snap.books.intraday.trades : (snap.books.intraday.stats || {}).trades;
  assert.strictEqual(n(alone), 2);
  assert.strictEqual(n(merged), 6);
});
