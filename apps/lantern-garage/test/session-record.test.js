'use strict';

/**
 * session-record.test.js — one queryable row per trading day.
 *
 * Verifying 2026-08-13's P&L required yesterday's closing equity, which nothing
 * had ever stored, so the only route was reconstructing it from bar closes and
 * a per-lot decomposition. That reconstruction is what exposed #3283 — the
 * check that should have caught it, equity(today) − equity(yesterday), was
 * unanswerable after the fact. These rows make it answerable.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildSessionRecord, shouldWriteSession, scanDay } = require('../lib/session-record');

const row = (o) => JSON.stringify(o);
// 2026-08-13 is a Thursday. 20:10Z = 16:10 ET, just after the close.
const AFTER_CLOSE = Date.parse('2026-08-13T20:10:00Z');
const MIDDAY = Date.parse('2026-08-13T17:00:00Z');       // 13:00 ET

const DAY = [
  row({ ts: '2026-08-13T14:06:00Z', event: 'entry', symbol: 'SPXS', qty: 2467, entry: 23.529, notional: 58046, tier: 'B' }),
  row({ ts: '2026-08-13T14:15:00Z', event: 'entry', symbol: 'GLD', qty: 289, entry: 401.05, notional: 115903, tier: 'A+' }),
  row({ ts: '2026-08-13T14:29:35Z', event: 'exit', symbol: 'SQQQ', qty: 1566, entry: 37.06, exit: 35.99, pnl: -1674.06, reason: 'closed_externally (protective stop, manual close, or another engine)' }),
  row({ ts: '2026-08-13T18:15:00Z', event: 'exit', symbol: 'DIA', qty: 216, entry: 536.23, exit: 537.35, pnl: 240.84, reason: 'signal_exit' }),
  row({ ts: '2026-08-13T15:52:00Z', event: 'slot_util', slots_used: 5, cap: 5, held: ['DIA', 'SOXS', 'SPXS', 'SQQQ'] }),
  row({ ts: '2026-08-13T15:53:00Z', event: 'slot_util', slots_used: 3, cap: 5, held: ['DIA', 'SPXS'] }),
  row({ ts: '2026-08-13T13:13:00Z', event: 'skip', symbol: 'SPY', reason: 'bearish, no long to exit' }),
  row({ ts: '2026-08-13T13:14:00Z', event: 'skip', symbol: 'QQQ', reason: 'bearish, no long to exit' }),
  row({ ts: '2026-08-13T13:15:00Z', event: 'skip', symbol: 'IWM', reason: 'p_win 0.41 < 0.55' }),
  row({ ts: '2026-08-13T13:16:00Z', event: 'skip', symbol: 'SMH', reason: 'p_win 0.38 < 0.55' }),
  // yesterday — must never leak into today's row
  row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'TLT', qty: 1413, entry: 82.18, notional: 116000, tier: 'A' }),
  row({ ts: '2026-08-12T18:00:00Z', event: 'exit', symbol: 'TLT', qty: 1413, entry: 82.18, exit: 82.57, pnl: 551.07, reason: 'signal_exit' }),
].join('\n');

const ACCOUNT = { equity: 973158.13, cash: 480503.31 };
const POSITIONS = [
  { symbol: 'SOXS', qty: 3057.8, current_price: 39.76, unrealized_pl: 5467.70, day_pnl: 5467.70 },
  { symbol: 'GLD', qty: 290, current_price: 399.56, unrealized_pl: -64.82, day_pnl: -64.82 },
];
const DAYPNL = {
  pnl_today: 2533.54, realized_today: -2974.64, realized_booked: 2144.95,
  unrealized_today: 5508.18, pnl_carry_adjustment: 5119.59, pnl_basis: 'realized + unrealized (today basis)',
};

test('writes at/after the close, not before', () => {
  assert.strictEqual(shouldWriteSession(DAY, MIDDAY), false, '13:00 ET is mid-session');
  assert.strictEqual(shouldWriteSession(DAY, AFTER_CLOSE), true, '16:10 ET is after the close');
});

test('never writes twice for the same date — checked against the LEDGER, not memory', () => {
  assert.strictEqual(shouldWriteSession(DAY, AFTER_CLOSE), true);
  const withRow = DAY + '\n' + row({ ts: '2026-08-13T20:05:00Z', event: 'session', date: '2026-08-13' });
  assert.strictEqual(shouldWriteSession(withRow, AFTER_CLOSE), false,
    'a restart mid-evening must not append a second row for the day');
});

test('no row on a weekend, or on a day the trader did nothing', () => {
  const saturday = Date.parse('2026-08-15T20:10:00Z');
  assert.strictEqual(shouldWriteSession(DAY, saturday), false, 'Saturday');
  assert.strictEqual(shouldWriteSession('', AFTER_CLOSE), false, 'an idle/holiday session earns no row');
});

test('the row carries the P&L figures VERBATIM from the panel computation', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.event, 'session');
  assert.strictEqual(r.date, '2026-08-13');
  assert.strictEqual(r.equity, 973158.13, 'the number that makes equity(today) − equity(yesterday) answerable');
  assert.strictEqual(r.cash, 480503.31);
  assert.strictEqual(r.day_pnl, 2533.54);
  assert.strictEqual(r.realized_today, -2974.64);
  assert.strictEqual(r.realized_booked, 2144.95);
  assert.strictEqual(r.carry_adjustment, 5119.59);
  assert.ok(r.pnl_basis, 'the basis is stored so a later reader never has to guess which one was in effect');
});

test('activity is scoped to TODAY — yesterday\'s rows do not leak in', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.entries, 2, 'TLT was entered yesterday');
  assert.strictEqual(r.exits, 2, 'TLT exited yesterday');
  assert.deepStrictEqual(r.symbols_entered, ['GLD', 'SPXS']);
});

test('tier split records where the day\'s size actually went', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.tiers['B'].n, 1);
  assert.strictEqual(r.tiers['B'].notional, 58046);
  assert.strictEqual(r.tiers['A+'].n, 1);
  assert.strictEqual(r.tiers['A+'].notional, 115903);
  assert.ok(!r.tiers['A'], 'yesterday\'s tier-A entry is not today\'s');
});

test('exits are grouped by mechanism, and stops are counted separately', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.exits_by_reason['signal_exit'].n, 1);
  assert.strictEqual(r.exits_by_reason['signal_exit'].pnl, 240.84);
  assert.strictEqual(r.exits_by_reason['closed_externally'].n, 1, 'the parenthetical is trimmed off the key');
  // The raw reason text for closed_externally contains the words "protective
  // stop" among three possibilities. It is the case where we do NOT know a stop
  // fired (#3281) — counting it would report maybes as facts.
  assert.strictEqual(r.stops_fired, 0, 'an ambiguous external close is not a confirmed stop');
});

test('a REAL stop is counted, so the tail-defense question stays measurable', () => {
  const led = DAY + '\n' + row({ ts: '2026-08-13T16:00:00Z', event: 'exit', symbol: 'XLK', qty: 10, entry: 100, exit: 97, pnl: -30, reason: 'trailing_stop' });
  const r = buildSessionRecord({ ledgerText: led, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.stops_fired, 1);
  assert.strictEqual(r.stops_pnl, -30);
});

test('slot high-water mark is kept — the concurrency question is throughput', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.max_slots_used, 5);
  assert.strictEqual(r.slot_cap, 5);
});

test('the book carried into tonight is recorded — that is what tomorrow\'s gap acts on', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.deepStrictEqual(r.carried_out.map((p) => p.symbol), ['GLD', 'SOXS']);
  assert.strictEqual(r.carried_out.find((p) => p.symbol === 'SOXS').unrealized, 5467.70);
  assert.strictEqual(r.open_risk, 5402.88, '5467.70 − 64.82');
});

test('skip reasons collapse numbers, so the histogram is readable', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: ACCOUNT, positions: POSITIONS, dayPnl: DAYPNL });
  assert.strictEqual(r.skips['bearish, no long to exit'], 2);
  assert.strictEqual(r.skips['p_win # < #'], 2, 'two different p_win values are ONE reason');
});

test('a missing account or empty dayPnl degrades to null, never to a fake 0', () => {
  const r = buildSessionRecord({ ledgerText: DAY, now: AFTER_CLOSE, account: {}, positions: [], dayPnl: {} });
  assert.strictEqual(r.equity, null);
  assert.strictEqual(r.day_pnl, null);
  assert.strictEqual(r.max_slots_used, 5, 'ledger-derived fields still work');
});

test('scanDay ignores unparseable lines rather than throwing', () => {
  const d = scanDay(DAY + '\n{not json\n' + row({ ts: '2026-08-13T19:00:00Z', event: 'entry', symbol: 'X', qty: 1, notional: 10, tier: 'C' }), AFTER_CLOSE);
  assert.strictEqual(d.entries.length, 3);
});
