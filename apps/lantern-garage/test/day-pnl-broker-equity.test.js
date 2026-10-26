'use strict';
/**
 * day-pnl-broker-equity.test.js — the account's Day P&L is its equity change since the previous close
 * (2026-10-26).
 *
 * The trade log only knows the longs the trader itself entered and exited. On 2026-10-26 the stable page
 * read Day P&L -$899.47 while the IBKR account went from $963,377.00 (Friday's close, as the trader
 * recorded it) to $965,004.06: +$1,627.06. The log had booked three XLE sells as exits of a 2,628-share
 * long (+$1,327 "realized") although two of them opened shorts, and the buys that covered them never
 * appear. Over 51 sessions the log's figure sat a median $607 from the account's real day.
 *
 * Pinned here:
 *   - reconcileDayPnl: Day P&L = equity - previous close; realized and the open-position move keep the
 *     log's figures; pnl_other is the rest, so the three still add up; pnl_ledger keeps the log's own;
 *     no previous close = the log's result, untouched;
 *   - prevSessionEquity: the previous TRADING day's last session row (weekends and holidays skipped by
 *     the calendar), never an older one;
 *   - the session record carries the account's day beside the book's own.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileDayPnl, prevSessionEquity } = require('../lib/day-pnl');
const { buildSessionRecord } = require('../lib/session-record');

const LEDGER_1026 = { realized_today: -904.22, unrealized_today: 4.75, pnl_today: -899.47, realized_booked: 1327.11, pnl_carry_adjustment: 2231.33, pnl_basis: 'ledger', per_position: [] };

test('the 2026-10-26 stable day: the account made +$1,627.06, not -$899.47', () => {
  const d = reconcileDayPnl(LEDGER_1026, { equity: 965004.06, prevEquity: 963377.00, prevSource: "the trader's 2026-10-23 session close" });
  assert.strictEqual(d.pnl_today, 1627.06);
  assert.strictEqual(d.pnl_ledger, -899.47, 'the log\'s own figure is kept');
  assert.strictEqual(d.pnl_today_source, 'broker_equity');
  assert.strictEqual(d.pnl_prev_equity, 963377);
  assert.strictEqual(d.realized_today, -904.22, 'realized keeps its ledger meaning');
  assert.strictEqual(d.unrealized_today, 4.75);
  assert.strictEqual(d.pnl_other, 2526.53);
  assert.strictEqual(Math.round((d.realized_today + d.unrealized_today + d.pnl_other) * 100) / 100, d.pnl_today, 'the three still add up');
  assert.match(d.pnl_basis, /^equity change since the previous close \(the trader's 2026-10-23 session close\): 965004\.06 - 963377\.00/);
  assert.match(d.pnl_basis, /other 2526\.53 \(commissions, holdings and fills the log did not record, short positions\)/);
});

test('no previous close on record: the log\'s figures stand, untouched', () => {
  assert.strictEqual(reconcileDayPnl(LEDGER_1026, { equity: 965004.06 }), LEDGER_1026);
  assert.strictEqual(reconcileDayPnl(LEDGER_1026, { equity: 965004.06, prevEquity: 0 }), LEDGER_1026);
  assert.strictEqual(reconcileDayPnl(LEDGER_1026, {}), LEDGER_1026);
});

test('the engine day agrees with the log: other is just the cents the log does not carry', () => {
  const d = reconcileDayPnl({ realized_today: 281.22, unrealized_today: 2.71, pnl_today: 283.93 }, { equity: 99109.58, prevEquity: 98828.51, prevSource: 'Alpaca last_equity' });
  assert.strictEqual(d.pnl_today, 281.07);
  assert.strictEqual(d.pnl_other, -2.86);
});

const row = (date, ts, equity) => JSON.stringify({ ts, event: 'session', date, equity });
const at = (iso) => Date.parse(iso);

test('the previous close is the previous TRADING day\'s last session row', () => {
  const ledger = [
    row('2026-10-22', '2026-10-22T20:00:45Z', 966305.13),
    row('2026-10-23', '2026-10-23T20:00:46Z', 963377.00),
    row('2026-10-23', '2026-10-23T20:31:02Z', 963380.50),          // a restart wrote a second row: the latest wins
    JSON.stringify({ ts: '2026-10-26T13:31:12Z', event: 'skip', symbol: 'XLE' }),
  ].join('\n');
  assert.deepStrictEqual(prevSessionEquity(ledger, at('2026-10-26T14:00:00Z')), { date: '2026-10-23', ts: '2026-10-23T20:31:02Z', equity: 963380.5 }, 'Monday reads Friday');
  assert.strictEqual(prevSessionEquity(ledger, at('2026-10-24T15:00:00Z')).date, '2026-10-23', 'a Saturday reads Friday');
  const monday = ledger + '\n' + row('2026-10-26', '2026-10-26T20:00:46Z', 965004.06);
  assert.strictEqual(prevSessionEquity(monday, at('2026-10-26T21:00:00Z')).date, '2026-10-23', 'after its own close the day still reads the previous one');
  assert.strictEqual(prevSessionEquity(monday, at('2026-10-27T14:00:00Z')).equity, 965004.06, 'Tuesday reads Monday');
});

test('a missing previous-day row is no baseline: never several days folded into one', () => {
  const ledger = row('2026-10-22', '2026-10-22T20:00:45Z', 966305.13);
  assert.strictEqual(prevSessionEquity(ledger, at('2026-10-26T14:00:00Z')), null, 'Thursday is not Monday\'s previous close');
  assert.strictEqual(prevSessionEquity('', at('2026-10-26T14:00:00Z')), null);
  assert.strictEqual(prevSessionEquity('not json\n{"event":"session"', at('2026-10-26T14:00:00Z')), null);
});

test('holidays are skipped: the Friday after Thanksgiving reads Wednesday', () => {
  const ledger = row('2026-11-25', '2026-11-25T21:00:40Z', 970000);
  assert.strictEqual(prevSessionEquity(ledger, at('2026-11-27T15:00:00Z')).date, '2026-11-25');
});

test('the session record carries the account\'s day beside the book\'s own', () => {
  const rec = buildSessionRecord({ ledgerText: '', now: at('2026-10-26T20:00:46Z'), account: { equity: 965004.06, cash: 850259.88 },
    positions: [], dayPnl: { ...LEDGER_1026, account_day_pnl: 1627.06, prev_equity: 963377 } });
  assert.strictEqual(rec.day_pnl, -899.47, 'the book\'s own figure is unchanged');
  assert.strictEqual(rec.account_day_pnl, 1627.06);
  assert.strictEqual(rec.prev_equity, 963377);
  const without = buildSessionRecord({ ledgerText: '', now: at('2026-10-26T20:00:46Z'), account: { equity: 1 }, positions: [], dayPnl: LEDGER_1026 });
  assert.ok(!('account_day_pnl' in without), 'no baseline, no field');
});
