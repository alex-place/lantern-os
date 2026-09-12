'use strict';
/**
 * test/trade-log.test.js — #3558.
 *
 * The list has to agree with the statistics drawn above it — a trade log that disagreed
 * with its own scorecard would make both untrustworthy — and it has to be honest about
 * the fields most of the record does not carry. Those two things are what is pinned here.
 *
 * Run: node --test apps/lantern-garage/test/trade-log.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLog, toTrade } = require('../lib/trade-log');
const { computeScorecard, preparedRows } = require('../lib/trader-scorecard');

/* Each fixture row is a DISTINCT round trip. The pipeline collapses duplicates keyed on
   (symbol, entry, qty) — correctly — so rows that shared those defaults would silently
   become one trade and every count in this file would be testing the dedupe instead of
   the thing it meant to. The entry price varies per row to keep them apart. */
let n = 0;
const row = (o) => {
  n += 1;
  return Object.assign({
    ts: '2026-09-0' + (1 + (n % 9)) + 'T18:00:00.000Z',
    event: 'exit', symbol: 'SPY', qty: 10, entry: 100 + n * 0.0001, exit: 105,
    pnl: 50, pnl_pct: 5, reason: 'signal_exit', status: 'filled',
    order_id: 'o' + n,
  }, o);
};

test('a row becomes a trade, with everything absent as null rather than zero', () => {
  const t = toTrade(row({ symbol: 'aapl', qty: 5, entry: 10, exit: 12, pnl: 10, pnl_pct: 20 }));
  assert.strictEqual(t.symbol, 'AAPL', 'normalised, so filtering by symbol works');
  assert.deepStrictEqual([t.qty, t.entry, t.exit, t.pnl], [5, 10, 12, 10]);
  assert.strictEqual(t.side, 'long', 'the autopilot book is long-only, so an absent side is a long');
  assert.strictEqual(t.heldMs, null, 'no open time on the row means no hold time, not zero');
  assert.strictEqual(t.r, null, 'and no recorded risk means no R');
  assert.strictEqual(t.mfe_pct, null);
  assert.strictEqual(t.reason, 'signal_exit');
});

test('hold time is computed only when the record actually supports it', () => {
  const held = toTrade(row({ opened_at: '2026-09-01T14:30:00.000Z', ts: '2026-09-01T18:00:00.000Z' }));
  assert.strictEqual(held.heldMs, 3.5 * 3600 * 1000);
  const backwards = toTrade(row({ opened_at: '2026-09-02T18:00:00.000Z', ts: '2026-09-01T14:30:00.000Z' }));
  assert.strictEqual(backwards.heldMs, null, 'a negative hold is a broken record, not a trade held backwards');
  const junk = toTrade(row({ opened_at: 'whenever' }));
  assert.strictEqual(junk.heldMs, null);
});

test('R is shown only where the risk taken was recorded', () => {
  assert.strictEqual(toTrade(row({ stop_dist_pct: 5, pnl_pct: 5 })).r, 1, 'a winner the size of the stop');
  assert.strictEqual(toTrade(row({ mfe_pct: 10, mfe_r: 2, pnl_pct: 5 })).r, 1, 'or recovered from an excursion');
  assert.strictEqual(toTrade(row({})).r, null);
});

test('a short is a short, and an imported trade keeps its side', () => {
  assert.strictEqual(toTrade(row({ side: 'short' })).side, 'short');
  assert.strictEqual(toTrade(row({ side: 'long' })).side, 'long');
});

test('a row with no order id still gets a stable id, not a missing one', () => {
  const a = toTrade(row({ order_id: undefined, ts: '2026-09-01T18:00:00Z', symbol: 'SPY', qty: 10 }));
  const b = toTrade(row({ order_id: undefined, ts: '2026-09-01T18:00:00Z', symbol: 'SPY', qty: 10 }));
  assert.ok(a.id, 'a row can always be addressed');
  assert.strictEqual(a.id, b.id, 'and the same trade is the same id');
  assert.notStrictEqual(a.id, toTrade(row({ order_id: undefined, symbol: 'QQQ' })).id);
});

test('the list counts exactly what the scorecard counts', () => {
  // The property that makes both trustworthy: same pipeline, not a re-implementation.
  const rows = [
    row({ symbol: 'A', pnl: 100 }),
    row({ symbol: 'B', pnl: -40 }),
    row({ symbol: 'C', pnl: 10, status: 'dry_run' }),        // strategy view only
    row({ symbol: 'D', pnl: 999, status: 'rejected' }),      // realized nothing
  ];
  const log = buildLog(rows);
  const card = computeScorecard(preparedRows(rows.filter((r) => r.status === 'filled')));
  assert.strictEqual(log.total, card.trades, 'the list is as long as the scorecard says');
  assert.strictEqual(log.totals.net, card.totalRealized, 'and sums to the same money');
  assert.ok(!log.trades.some((t) => t.symbol === 'D'), 'a rejected attempt is in neither');
  assert.ok(!log.trades.some((t) => t.symbol === 'C'), 'nor a dry run, in the confirmed view');
});

test('the strategy view includes the decisions the booked view excludes', () => {
  const rows = [row({ symbol: 'A', pnl: 100 }), row({ symbol: 'C', pnl: 10, status: 'dry_run' })];
  assert.strictEqual(buildLog(rows, { view: 'all' }).total, 2);
  assert.strictEqual(buildLog(rows).total, 1, 'and the default stays the honest one');
});

test('duplicate re-decisions collapse before the list is drawn', () => {
  // Two rows for one round trip must be one line, or the list disagrees with every figure.
  const dupe = { symbol: 'IWM', qty: 7, entry: 50.123456, status: 'filled', event: 'exit' };
  const rows = [
    Object.assign({}, dupe, { ts: '2026-09-01T14:00:00Z', pnl: 900, pnl_pct: 9, order_id: 'd1' }),
    Object.assign({}, dupe, { ts: '2026-09-01T19:00:00Z', pnl: 20, pnl_pct: 0.2, order_id: 'd2' }),
  ];
  const log = buildLog(rows);
  assert.strictEqual(log.total, 1);
  assert.strictEqual(log.trades[0].pnl, 20, 'the last row is the survivor, as everywhere else');
});

test('newest first by default', () => {
  const log = buildLog([
    row({ symbol: 'OLD', ts: '2026-09-01T18:00:00Z' }),
    row({ symbol: 'NEW', ts: '2026-09-05T18:00:00Z' }),
    row({ symbol: 'MID', ts: '2026-09-03T18:00:00Z' }),
  ]);
  assert.deepStrictEqual(log.trades.map((t) => t.symbol), ['NEW', 'MID', 'OLD']);
});

test('sorting by any column, both ways, with the unmeasurable parked', () => {
  const rows = [
    row({ symbol: 'AAA', pnl: 10, stop_dist_pct: 5, pnl_pct: 5 }),
    row({ symbol: 'BBB', pnl: -30 }),                           // no R
    row({ symbol: 'CCC', pnl: 200, stop_dist_pct: 5, pnl_pct: 20 }),
  ];
  assert.deepStrictEqual(buildLog(rows, { sort: 'pnl', dir: 'desc' }).trades.map((t) => t.symbol), ['CCC', 'AAA', 'BBB']);
  assert.deepStrictEqual(buildLog(rows, { sort: 'pnl', dir: 'asc' }).trades.map((t) => t.symbol), ['BBB', 'AAA', 'CCC']);
  assert.deepStrictEqual(buildLog(rows, { sort: 'symbol', dir: 'asc' }).trades.map((t) => t.symbol), ['AAA', 'BBB', 'CCC']);
  for (const dir of ['asc', 'desc']) {
    const byR = buildLog(rows, { sort: 'r', dir }).trades.map((t) => t.symbol);
    assert.strictEqual(byR[byR.length - 1], 'BBB', 'dir ' + dir + ': a trade with no R never heads the list');
  }
});

test('an unknown sort or direction falls back rather than returning nothing', () => {
  const log = buildLog([row({}), row({})], { sort: 'nonsense', dir: 'sideways' });
  assert.deepStrictEqual([log.sort, log.dir], ['ts', 'desc']);
  assert.strictEqual(log.trades.length, 2);
});

test('filtering by symbol, result and date', () => {
  const rows = [
    row({ symbol: 'AAPL', pnl: 100, ts: '2026-09-01T18:00:00Z' }),
    row({ symbol: 'AAPL', pnl: -50, ts: '2026-09-05T18:00:00Z' }),
    row({ symbol: 'MSFT', pnl: 20, ts: '2026-09-10T18:00:00Z' }),
  ];
  assert.strictEqual(buildLog(rows, { symbol: 'aapl' }).total, 2, 'case does not matter to the reader');
  assert.strictEqual(buildLog(rows, { result: 'win' }).total, 2);
  assert.strictEqual(buildLog(rows, { result: 'loss' }).total, 1);
  assert.strictEqual(buildLog(rows, { from: '2026-09-05' }).total, 2);
  assert.strictEqual(buildLog(rows, { to: '2026-09-05' }).total, 2, 'a named end date includes that whole day');
  assert.strictEqual(buildLog(rows, { from: '2026-09-02', to: '2026-09-09' }).total, 1);
});

test('the totals describe the filtered set, not the page', () => {
  // A reader who filters to one symbol is asking what that symbol did. Answering with
  // whatever happened to fit on the current page would be a different, wrong number.
  const rows = Array.from({ length: 30 }, (_, i) => row({ symbol: i % 2 ? 'AAPL' : 'MSFT', pnl: i % 2 ? 10 : -5 }));
  const log = buildLog(rows, { symbol: 'AAPL', limit: 5 });
  assert.strictEqual(log.trades.length, 5, 'one page');
  assert.strictEqual(log.total, 15, 'of fifteen');
  assert.strictEqual(log.totals.net, 150, 'and the money is all fifteen, not the five shown');
  assert.deepStrictEqual([log.totals.wins, log.totals.losses], [15, 0]);
});

test('paging walks the whole set once, with no trade shown twice or skipped', () => {
  const rows = Array.from({ length: 47 }, (_, i) => row({ symbol: 'S' + i, pnl: i }));
  const seen = [];
  for (let offset = 0; offset < 100; offset += 10) {
    const page = buildLog(rows, { limit: 10, offset });
    if (!page.trades.length) break;
    seen.push(...page.trades.map((t) => t.id));
  }
  assert.strictEqual(seen.length, 47);
  assert.strictEqual(new Set(seen).size, 47, 'no trade appeared on two pages');
});

test('the page size is capped, so one request cannot ask for the whole ledger', () => {
  const rows = Array.from({ length: 400 }, () => row({}));
  assert.strictEqual(buildLog(rows, { limit: 100000 }).trades.length, 200);
  assert.strictEqual(buildLog(rows, { limit: -5 }).trades.length, 1, 'and a nonsense page size is not zero rows');
});

test('the symbol list offers what is actually in the book, unfiltered', () => {
  const rows = [row({ symbol: 'AAPL' }), row({ symbol: 'MSFT' }), row({ symbol: 'AAPL' })];
  const log = buildLog(rows, { symbol: 'AAPL' });
  assert.deepStrictEqual(log.symbols, ['AAPL', 'MSFT'], 'still both, so the filter can be changed back');
});

test('an empty book is an empty list, not a crash', () => {
  for (const bad of [[], null, undefined]) {
    const log = buildLog(bad);
    assert.deepStrictEqual([log.trades, log.total, log.totals.net], [[], 0, 0], String(bad));
    assert.deepStrictEqual(log.symbols, []);
  }
});
