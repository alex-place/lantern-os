'use strict';

/**
 * day-pnl-carry-basis.test.js — Day P&L must not count yesterday's gains twice.
 *
 * A lot opened before today and closed today banks its FULL lifetime P&L into
 * today's realized figure, but every dollar it earned before this morning was
 * already inside yesterday's closing equity. Adding that to today's unrealized
 * double-counts it. The unrealized term was fixed in 2026-08-08; the realized
 * term was not, until #3283.
 *
 * The headline case is the live 2026-08-13 session, reproduced at the bottom
 * from the real ledger rows and the real 8/12 closes.
 */

const test = require('node:test');
const assert = require('node:assert');
const { computeDayPnl, scanLedger, exitOpenedToday } = require('../lib/day-pnl');

// 2026-08-13 was a Thursday; 14:00Z = 10:00 ET, mid-session.
const NOW = Date.parse('2026-08-13T14:00:00Z');
const row = (o) => JSON.stringify(o);

// chg_pct that puts prevClose exactly at `prev` for a given last price
const quote = (ticker, price, prev) => ({ ticker, price, chg_pct: ((price - prev) / prev) * 100 });
const quoter = (list) => async (syms) => list.filter((q) => syms.includes(q.ticker));

test('a lot opened AND closed today counts in full', async () => {
  const ledger = [
    row({ ts: '2026-08-13T14:10:00Z', event: 'entry', symbol: 'IWM', qty: 100, entry: 300 }),
    row({ ts: '2026-08-13T14:30:00Z', event: 'exit', symbol: 'IWM', qty: 100, entry: 300, exit: 302, pnl: 200 }),
  ].join('\n');
  const r = await computeDayPnl({ positions: [], ledgerText: ledger, now: Date.parse('2026-08-13T15:00:00Z'), getQuotes: quoter([]) });
  assert.strictEqual(r.realized_attributable, 200);
  assert.strictEqual(r.pnl_carry_adjustment, 0, 'nothing was carried, so nothing to strip');
  assert.strictEqual(r.pnl_today, 200);
});

test('a CARRIED lot contributes only its move since yesterday’s close', async () => {
  // bought at 90 days ago, closed 8/12 at 100, sold today at 98.
  // Lifetime +$800 on 100sh; only -$200 belongs to today.
  const ledger = [
    row({ ts: '2026-08-11T14:10:00Z', event: 'entry', symbol: 'SQQQ', qty: 100, entry: 90 }),
    row({ ts: '2026-08-13T14:30:00Z', event: 'exit', symbol: 'SQQQ', qty: 100, entry: 90, exit: 98, pnl: 800 }),
  ].join('\n');
  const r = await computeDayPnl({
    positions: [], ledgerText: ledger, now: NOW,
    getQuotes: quoter([quote('SQQQ', 98, 100)]),
  });
  assert.strictEqual(r.realized_today, 800, 'the broker sense of realized stays whole');
  assert.strictEqual(r.realized_attributable, -200, 'only today’s leg counts toward the day');
  assert.strictEqual(r.pnl_carry_adjustment, 1000, 'the pre-today gain that was double-counted');
  assert.strictEqual(r.pnl_today, -200);
});

test('sold and RE-ENTERED the same day: first lot carried, second lot today', async () => {
  // The GLD shape. A symbol-level "last entry was today?" map calls BOTH exits
  // today-opened and mis-books the 04:05 one.
  const ledger = [
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'GLD', qty: 265, entry: 400.28 }),
    row({ ts: '2026-08-13T08:05:00Z', event: 'exit', symbol: 'GLD', qty: 265, entry: 400.28, exit: 400.40, pnl: 31.80 }),
    row({ ts: '2026-08-13T14:15:00Z', event: 'entry', symbol: 'GLD', qty: 81, entry: 401.12 }),
    row({ ts: '2026-08-13T14:54:00Z', event: 'exit', symbol: 'GLD', qty: 81, entry: 401.12, exit: 402.18, pnl: 86.26 }),
  ].join('\n');
  const { entryTsBySym, exits } = scanLedger(ledger, NOW);
  assert.strictEqual(exitOpenedToday(entryTsBySym, exits[0]), false, '04:05 predates today’s 10:15 entry');
  assert.strictEqual(exitOpenedToday(entryTsBySym, exits[1]), true, '10:54 follows it');

  const r = await computeDayPnl({
    positions: [], ledgerText: ledger, now: Date.parse('2026-08-13T19:00:00Z'),
    getQuotes: quoter([quote('GLD', 400.40, 404.66)]),
  });
  // carried leg: (400.40 − 404.66) × 265 = −1128.90 ; today's lot: +86.26
  assert.ok(Math.abs(r.realized_attributable - (-1128.90 + 86.26)) < 0.02, `got ${r.realized_attributable}`);
});

test('carried lots already CLOSED still get a quote — they are not in positions', async () => {
  // The old call site only fetched quotes for carried OPEN positions, so a
  // carried lot closed earlier today had no prevClose available at all.
  const ledger = [
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'TLT', qty: 100, entry: 82.18 }),
    row({ ts: '2026-08-13T13:39:00Z', event: 'exit', symbol: 'TLT', qty: 100, entry: 82.18, exit: 82.57, pnl: 39 }),
  ].join('\n');
  let asked = null;
  const r = await computeDayPnl({
    positions: [], ledgerText: ledger, now: NOW,
    getQuotes: async (syms) => { asked = syms; return [quote('TLT', 82.57, 82.05)]; },
  });
  assert.deepStrictEqual(asked, ['TLT'], 'the closed carried symbol must be quoted');
  assert.ok(Math.abs(r.realized_attributable - 52) < 0.02, `(82.57−82.05)×100 = 52, got ${r.realized_attributable}`);
});

test('no prevClose → falls back to the whole lot AND says so', async () => {
  const ledger = [
    row({ ts: '2026-08-11T14:00:00Z', event: 'entry', symbol: 'ZZZZ', qty: 10, entry: 5 }),
    row({ ts: '2026-08-13T14:30:00Z', event: 'exit', symbol: 'ZZZZ', qty: 10, entry: 5, exit: 9, pnl: 40 }),
  ].join('\n');
  const r = await computeDayPnl({ positions: [], ledgerText: ledger, now: NOW, getQuotes: quoter([]) });
  assert.strictEqual(r.realized_attributable, 40, 'no basis to strip with → keep it whole');
  assert.strictEqual(r.degraded, true);
  assert.match(r.pnl_basis, /prevClose unavailable/);
});

test('a quote failure never throws — the endpoint must still answer', async () => {
  const ledger = row({ ts: '2026-08-13T14:30:00Z', event: 'exit', symbol: 'X', qty: 1, entry: 1, exit: 2, pnl: 1 });
  const r = await computeDayPnl({
    positions: [], ledgerText: ledger, now: NOW,
    getQuotes: async () => { throw new Error('yahoo down'); },
  });
  assert.strictEqual(r.pnl_today, 1);
});

test('superseded rows are excluded (the phantom-exit repair stays repaired)', async () => {
  const ledger = [
    row({ ts: '2026-08-13T13:30:00Z', event: 'exit_superseded', symbol: 'SPMO', qty: 10, exit: 5, pnl_stale: -199.35 }),
    row({ ts: '2026-08-13T14:10:00Z', event: 'entry', symbol: 'IWM', qty: 10, entry: 300 }),
    row({ ts: '2026-08-13T14:30:00Z', event: 'exit', symbol: 'IWM', qty: 10, entry: 300, exit: 301, pnl: 10 }),
  ].join('\n');
  const r = await computeDayPnl({ positions: [], ledgerText: ledger, now: Date.parse('2026-08-13T15:00:00Z'), getQuotes: quoter([]) });
  assert.strictEqual(r.realized_today, 10, 'the superseded phantom must not reappear');
});

test('weekend/pre-open: carried OPEN positions contribute $0, not Friday’s move', async () => {
  const ledger = row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'GLD', qty: 10, entry: 400 });
  const sunday = Date.parse('2026-08-16T15:00:00Z');
  const r = await computeDayPnl({
    positions: [{ symbol: 'GLD', qty: 10, current_price: 410, unrealized_pl: 100 }],
    ledgerText: ledger, now: sunday, getQuotes: quoter([quote('GLD', 410, 405)]),
  });
  assert.strictEqual(r.pnl_today, 0);
  assert.match(r.pnl_basis, /no session today/);
});

test('an open position entered TODAY uses since-entry unrealized', async () => {
  const ledger = row({ ts: '2026-08-13T14:15:00Z', event: 'entry', symbol: 'SOXS', qty: 100, entry: 37.97 });
  const r = await computeDayPnl({
    positions: [{ symbol: 'SOXS', qty: 100, current_price: 39.76, unrealized_pl: 179 }],
    ledgerText: ledger, now: Date.parse('2026-08-13T19:00:00Z'), getQuotes: quoter([]),
  });
  assert.strictEqual(r.unrealized_today, 179);
});

// ── the live session this fixes ────────────────────────────────────────────
test('2026-08-13 end of day: +$2,533.54, not the +$7,653.13 the header showed', async () => {
  const ledger = [
    // carried in from 8/12
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'GLD', qty: 265, entry: 400.28 }),
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'SOXS', qty: 2929, entry: 39.50 }),
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'TLT', qty: 1413, entry: 82.18 }),
    row({ ts: '2026-08-12T14:00:00Z', event: 'entry', symbol: 'SQQQ', qty: 1566, entry: 37.07 }),
    // today's exits of those carried lots
    row({ ts: '2026-08-13T08:05:00Z', event: 'exit', symbol: 'GLD', qty: 265, entry: 400.28, exit: 400.3963, pnl: 32.14 }),
    row({ ts: '2026-08-13T13:35:00Z', event: 'exit', symbol: 'SOXS', qty: 2929, entry: 39.50, exit: 40.4353, pnl: 2753.62 }),
    row({ ts: '2026-08-13T13:39:00Z', event: 'exit', symbol: 'TLT', qty: 1313, entry: 82.18, exit: 82.57, pnl: 518.63 }),
    row({ ts: '2026-08-13T13:50:00Z', event: 'exit', symbol: 'TLT', qty: 100, entry: 82.18, exit: 82.65, pnl: 47.50 }),
    row({ ts: '2026-08-13T14:29:35Z', event: 'exit', symbol: 'SQQQ', qty: 1566, entry: 37.065003, exit: 35.9960022, pnl: -1674.06 }),
    // today's entries
    row({ ts: '2026-08-13T14:06:00Z', event: 'entry', symbol: 'SPXS', qty: 2467, entry: 23.529 }),
    row({ ts: '2026-08-13T14:15:00Z', event: 'entry', symbol: 'GLD', qty: 289, entry: 401.05 }),
    row({ ts: '2026-08-13T14:25:00Z', event: 'entry', symbol: 'SOXS', qty: 1490, entry: 38.92 }),
    row({ ts: '2026-08-13T14:29:38Z', event: 'entry', symbol: 'SQQQ', qty: 1614, entry: 35.915 }),
    row({ ts: '2026-08-13T15:15:00Z', event: 'entry', symbol: 'SOXS', qty: 1567, entry: 37.07 }),
    row({ ts: '2026-08-13T15:31:00Z', event: 'entry', symbol: 'DIA', qty: 216, entry: 536.18 }),
    row({ ts: '2026-08-13T15:52:00Z', event: 'entry', symbol: 'IWM', qty: 384, entry: 302.895 }),
    row({ ts: '2026-08-13T17:44:00Z', event: 'entry', symbol: 'IWM', qty: 382, entry: 303.05 }),
    row({ ts: '2026-08-13T18:09:00Z', event: 'entry', symbol: 'GLD', qty: 290, entry: 399.71 }),
    // today's exits of today's lots
    row({ ts: '2026-08-13T14:54:00Z', event: 'exit', symbol: 'GLD', qty: 81, entry: 401.115, exit: 402.18, pnl: 86.26 }),
    row({ ts: '2026-08-13T15:15:39Z', event: 'exit', symbol: 'GLD', qty: 40, entry: 401.115, exit: 400.79, pnl: -13.00 }),
    row({ ts: '2026-08-13T15:23:00Z', event: 'exit', symbol: 'GLD', qty: 26, entry: 401.115, exit: 400.60, pnl: -13.39 }),
    row({ ts: '2026-08-13T16:38:00Z', event: 'exit', symbol: 'IWM', qty: 80, entry: 302.91, exit: 303.20, pnl: 23.60 }),
    row({ ts: '2026-08-13T16:54:00Z', event: 'exit', symbol: 'IWM', qty: 304, entry: 302.91, exit: 303.19, pnl: 83.60 }),
    row({ ts: '2026-08-13T18:09:00Z', event: 'exit', symbol: 'IWM', qty: 382, entry: 303.04, exit: 303.19, pnl: 59.21 }),
    row({ ts: '2026-08-13T18:15:00Z', event: 'exit', symbol: 'DIA', qty: 216, entry: 536.23, exit: 537.35, pnl: 240.84 }),
  ].join('\n');

  // the four positions still open at the close — all opened today
  const positions = [
    { symbol: 'SQQQ', qty: 1614, current_price: 35.98, unrealized_pl: 121.04 },
    { symbol: 'SPXS', qty: 2467, current_price: 23.53, unrealized_pl: -15.74 },
    { symbol: 'SOXS', qty: 3057.8, current_price: 39.76, unrealized_pl: 5467.70 },
    { symbol: 'GLD', qty: 290, current_price: 399.56, unrealized_pl: -64.82 },
  ];
  // real 8/12 closes
  const quotes = [
    quote('GLD', 400.3963, 404.66), quote('SOXS', 40.4353, 40.6794),
    quote('TLT', 82.57, 82.05), quote('SQQQ', 35.9960022, 37.49),
  ];

  const r = await computeDayPnl({
    positions, ledgerText: ledger, now: Date.parse('2026-08-13T20:10:00Z'),
    getQuotes: quoter(quotes),
  });

  assert.ok(Math.abs(r.realized_today - 2144.95) < 0.05, `realized stays whole: ${r.realized_today}`);
  assert.ok(Math.abs(r.unrealized_today - 5508.18) < 0.05, `unrealized: ${r.unrealized_today}`);
  assert.ok(Math.abs(r.pnl_carry_adjustment - 5119.60) < 1.0, `carry stripped: ${r.pnl_carry_adjustment}`);
  assert.ok(Math.abs(r.pnl_today - 2533.54) < 1.0, `TRUE day P&L: ${r.pnl_today}`);
  assert.ok(r.pnl_today < 7653.13 - 5000, 'must not print the double-counted header figure');
});
