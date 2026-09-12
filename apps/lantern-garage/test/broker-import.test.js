'use strict';
/**
 * test/broker-import.test.js — #3557.
 *
 * The import writes into the SAME ledger the autopilot writes, and the journal reads it
 * without knowing which is which. So the things that matter are the ones that would
 * corrupt that shared record: importing twice, importing a trade the autopilot already
 * journaled, journaling a position that is still open, and a broker outage that looks
 * like a user with no trades.
 *
 * Run: node --test apps/lantern-garage/test/broker-import.test.js
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { importForUser, planImport, existingExitIds, alpacaFetcher } = require('../lib/broker-import');
const { roundTrips } = require('../lib/round-trips');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-import-'));
const LOG = path.join(DIR, 'trades.jsonl');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });
beforeEach(() => { try { fs.unlinkSync(LOG); } catch (_e) { /* first run */ } });

const readLog = () => {
  let t = ''; try { t = fs.readFileSync(LOG, 'utf8'); } catch (_e) { return []; }
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const FILLS = [
  { id: 'o1', symbol: 'AAPL', side: 'buy', qty: 10, price: 150, at: '2026-09-01T14:30:00Z' },
  { id: 'o2', symbol: 'AAPL', side: 'sell', qty: 10, price: 155, at: '2026-09-01T18:00:00Z' },
  { id: 'o3', symbol: 'MSFT', side: 'buy', qty: 5, price: 400, at: '2026-09-02T14:30:00Z' },
  { id: 'o4', symbol: 'MSFT', side: 'sell', qty: 5, price: 390, at: '2026-09-02T16:00:00Z' },
];
const feed = (fills) => async () => fills;

test('a manual trader\'s fills become journal rows', async () => {
  const r = await importForUser('u-1', { fetchFills: feed(FILLS), logPath: LOG });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.fills, r.closedTrades, r.imported], [4, 2, 2]);

  const rows = readLog();
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((x) => x.event === 'exit'), 'the journal reads exit rows and nothing else');
  assert.ok(rows.every((x) => x.user === 'u-1'), 'attributed, so one user\'s journal is not everyone\'s');
  assert.ok(rows.every((x) => x.source === 'broker-import'), 'and always distinguishable from an autopilot row');
  const byS = Object.fromEntries(rows.map((x) => [x.symbol, x]));
  assert.strictEqual(byS.AAPL.pnl, 50);
  assert.strictEqual(byS.MSFT.pnl, -50);
  assert.strictEqual(byS.AAPL.ts, '2026-09-01T18:00:00Z', 'booked when it closed, not when it was imported');
});

test('importing twice changes nothing', async () => {
  await importForUser('u-1', { fetchFills: feed(FILLS), logPath: LOG });
  const second = await importForUser('u-1', { fetchFills: feed(FILLS), logPath: LOG });
  assert.strictEqual(second.imported, 0);
  assert.strictEqual(second.alreadyHad, 2, 'both were recognised, not re-added');
  assert.strictEqual(readLog().length, 2, 'the ledger did not grow');
});

test('a trade the autopilot already journaled is not imported on top of it', async () => {
  // The autopilot writes the broker's order id too, so the same close is the same id.
  fs.writeFileSync(LOG, JSON.stringify({
    ts: '2026-09-01T18:00:00Z', user: 'u-1', event: 'exit', symbol: 'AAPL', qty: 10,
    entry: 150, exit: 155, pnl: 50, order_id: 'o2', status: 'filled', source: 'fill',
  }) + '\n');
  const r = await importForUser('u-1', { fetchFills: feed(FILLS), logPath: LOG });
  assert.strictEqual(r.imported, 1, 'only the trade that was missing');
  const rows = readLog();
  assert.strictEqual(rows.filter((x) => x.symbol === 'AAPL').length, 1, 'AAPL is not in there twice');
  assert.strictEqual(rows.find((x) => x.symbol === 'AAPL').source, 'fill', 'and the autopilot\'s own row stands');
});

test('another user\'s row with the same order id does not block the import', async () => {
  fs.writeFileSync(LOG, JSON.stringify({
    ts: '2026-09-01T18:00:00Z', user: 'someone-else', event: 'exit', symbol: 'AAPL',
    qty: 10, entry: 150, exit: 155, pnl: 50, order_id: 'o2', status: 'filled',
  }) + '\n');
  const r = await importForUser('u-1', { fetchFills: feed(FILLS), logPath: LOG });
  assert.strictEqual(r.imported, 2, 'both of this user\'s trades still arrive');
});

test('a position still open is reported, never journaled', async () => {
  const half = FILLS.slice(0, 1).concat([
    { id: 'o9', symbol: 'AAPL', side: 'sell', qty: 4, price: 160, at: '2026-09-01T17:00:00Z' },
  ]);
  const r = await importForUser('u-1', { fetchFills: feed(half), logPath: LOG });
  assert.strictEqual(r.imported, 0, 'six shares are still at risk');
  assert.strictEqual(r.stillOpen.length, 1);
  assert.deepStrictEqual([r.stillOpen[0].symbol, r.stillOpen[0].qty], ['AAPL', 6]);
  assert.strictEqual(readLog().length, 0, 'nothing booked');
});

test('a broker that is down does not look like a user with no trades', async () => {
  const boom = async () => { throw new Error('502 from broker'); };
  const r = await importForUser('u-1', { fetchFills: boom, logPath: LOG });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'fetch_failed');
  assert.match(r.message, /502/);
  assert.strictEqual(readLog().length, 0);

  const junk = await importForUser('u-1', { fetchFills: async () => ({ nope: true }), logPath: LOG });
  assert.strictEqual(junk.ok, false, 'and neither does a malformed response');
});

test('no user, or no source, is refused rather than half-done', async () => {
  assert.strictEqual((await importForUser(null, { fetchFills: feed(FILLS), logPath: LOG })).error, 'no_user');
  assert.strictEqual((await importForUser('u-1', { logPath: LOG })).error, 'no_source');
  assert.strictEqual(readLog().length, 0);
});

test('a trade whose close cannot be identified is refused, not added every run', () => {
  // Without a stable id there is no way to know we have it already, so importing it
  // repeatedly would quietly inflate the record.
  const trips = [{ symbol: 'AAPL', side: 'long', qty: 1, entry: 1, exit: 2, pnl: 1, order_id: null }];
  const { rows, skipped } = planImport(trips, new Set(), 'u-1');
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(skipped[0].reason, 'no_id');
});

test('a duplicate inside one feed is imported once', () => {
  const trip = { symbol: 'AAPL', side: 'long', qty: 1, entry: 1, exit: 2, pnl: 1, pnl_pct: 100, order_id: 'x1' };
  const { rows } = planImport([trip, trip], new Set(), 'u-1');
  assert.strictEqual(rows.length, 1);
});

test('existingExitIds reads only exits, and only this user\'s', () => {
  fs.writeFileSync(LOG, [
    { event: 'exit', user: 'u-1', order_id: 'a' },
    { event: 'entry', user: 'u-1', order_id: 'b' },
    { event: 'exit', user: 'u-2', order_id: 'c' },
    { event: 'exit', user: 'u-1' },
    'not json',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
  const ids = existingExitIds('u-1', LOG);
  assert.deepStrictEqual([...ids], ['a']);
  assert.strictEqual(existingExitIds('u-1', path.join(DIR, 'nope.jsonl')).size, 0, 'no ledger yet is not a crash');
});

test('the Alpaca fetcher pages until the history runs out', async () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({
    id: 'order-' + (from + i), activityId: 'act-' + (from + i), symbol: 'AAPL',
    side: i % 2 ? 'sell' : 'buy', qty: 1, filled_avg_price: 100 + i,
    filled_at: new Date(1788000000000 + (from + i) * 60000).toISOString(),
  }));
  const calls = [];
  const alpaca = {
    async getFillActivities(userId, size, token) {
      calls.push(token);
      if (calls.length === 1) return page(100, 0);
      if (calls.length === 2) return page(100, 100);
      return page(7, 200);            // a short page ends the listing
    },
  };
  const fills = await alpacaFetcher(alpaca)('u-1');
  assert.strictEqual(fills.length, 207, 'a backfill does not stop at the first hundred');
  assert.deepStrictEqual(calls, [null, 'act-99', 'act-199'], 'each page continues from the last activity');
  assert.ok(fills.every((f) => f.price > 0 && f.at), 'and arrives in the shape the matcher takes');
});

test('the fetcher stops rather than looping when the cursor stops moving', async () => {
  const same = () => Array.from({ length: 100 }, () => ({
    id: 'o', activityId: 'stuck', symbol: 'AAPL', side: 'buy', qty: 1,
    filled_avg_price: 100, filled_at: '2026-09-01T14:00:00Z',
  }));
  const alpaca = { async getFillActivities() { return same(); } };
  const fills = await alpacaFetcher(alpaca, { maxPages: 50 })('u-1');
  assert.strictEqual(fills.length, 200, 'one page, then the repeat is detected and it stops');
});

test('a broker with no fill history is not an error', async () => {
  const alpaca = { async getFillActivities() { return []; } };
  assert.deepStrictEqual(await alpacaFetcher(alpaca)('u-1'), []);
  assert.deepStrictEqual(await alpacaFetcher(null)('u-1'), [], 'and neither is a broker that is not connected');
});

test('end to end: fills a broker would return become a journal the cards can read', async () => {
  const raw = [
    { id: 'A1', activityId: 'x1', symbol: 'NVDA', side: 'buy', qty: 4, filled_avg_price: 100, filled_at: '2026-09-01T14:00:00Z' },
    { id: 'A2', activityId: 'x2', symbol: 'NVDA', side: 'buy', qty: 6, filled_avg_price: 110, filled_at: '2026-09-01T14:30:00Z' },
    { id: 'A3', activityId: 'x3', symbol: 'NVDA', side: 'sell', qty: 10, filled_avg_price: 120, filled_at: '2026-09-01T15:30:00Z' },
  ];
  const alpaca = { async getFillActivities(u, n, token) { return token ? [] : raw; } };
  const r = await importForUser('u-7', { fetchFills: alpacaFetcher(alpaca), logPath: LOG });
  assert.deepStrictEqual([r.ok, r.closedTrades, r.imported], [true, 1, 1]);

  const row = readLog()[0];
  assert.strictEqual(row.symbol, 'NVDA');
  assert.strictEqual(row.qty, 10);
  assert.strictEqual(row.entry, 106, 'the weighted average of two buys');
  assert.strictEqual(row.exit, 120);
  assert.strictEqual(row.pnl, 140);

  // And the thing that makes this worth doing: the scorecard reads it as a real trade.
  const { scorecard } = require('../lib/trader-scorecard');
  const card = scorecard(LOG, 'u-7');
  assert.strictEqual(card.confirmed.trades, 1);
  assert.strictEqual(card.confirmed.totalRealized, 140);
  assert.strictEqual(card.confirmed.winRate, 100);
});
