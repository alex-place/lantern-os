'use strict';
/**
 * day-pnl-unknown-lot.test.js — a ledger that never saw the entry cannot call
 * the lot CARRIED (#3353).
 *
 * The classifier was two-state: `lastEntryDay.get(sym) !== today` meant carried.
 * That is also true when the ledger has no row for the symbol AT ALL, so any
 * surface whose ledger did not write the entries charged a position opened TODAY
 * with the entire overnight gap.
 *
 * Live 2026-08-18 on :4178 (an instance that scans but never trades, so its
 * ledger holds 980 rows for the day and zero entries): SMH, opened 09:30 at
 * 575.22 and marked 567.55, showed -$5,573.27 — the move from the PRIOR close of
 * 595.00 — against a true -$1,798.48. GLD showed -$1,720.67 against +$47.57. The
 * header read -$8,624 on a day that was really about -$5,412.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeDayPnl } = require('../lib/day-pnl');

const row = (o) => JSON.stringify(o);
const quote = (ticker, price, prev) => ({ ticker, price, chg_pct: ((price - prev) / prev) * 100 });
const quoter = (list) => async (syms) => list.filter((q) => syms.includes(q.ticker));
const MON = Date.parse('2026-08-18T15:55:00Z');   // Tue 11:55 ET, session live

// SMH: opened today 09:30 @575.22, marked 567.55, prior close 595.00.
const SMH = { symbol: 'SMH', qty: 203, current_price: 567.55, unrealized_pl: (567.55 - 575.22) * 203 };

test('the live bug: a held symbol with NO entry row is not treated as carried', async () => {
  const ledger = row({ ts: '2026-08-18T13:40:00Z', event: 'skip', symbol: 'SMH', reason: 'no entry rows here' });
  const r = await computeDayPnl({
    positions: [SMH], ledgerText: ledger, now: MON,
    getQuotes: quoter([quote('SMH', 567.55, 595.00)]),
  });
  assert.ok(Math.abs(r.unrealized_today - SMH.unrealized_pl) < 0.01,
    `since-entry expected (${SMH.unrealized_pl.toFixed(2)}), got ${r.unrealized_today}`);
  const gap = (567.55 - 595.00) * 203;
  assert.ok(Math.abs(r.unrealized_today - gap) > 3000, 'must NOT be the overnight-gap figure');
  assert.strictEqual(r.per_position[0].day_basis, 'since_entry_unknown_lot');
});

test('the fallback is DECLARED, never silent', async () => {
  const r = await computeDayPnl({
    positions: [SMH], ledgerText: '', now: MON,
    getQuotes: quoter([quote('SMH', 567.55, 595.00)]),
  });
  assert.match(r.pnl_basis, /no entry row in this ledger/);
  assert.match(r.pnl_basis, /NOT as carried/);
});

test('a GENUINELY carried lot still uses prevClose — the #3283 fix is intact', async () => {
  // entry row on a PRIOR day => carried => only today's move counts.
  const ledger = row({ ts: '2026-08-17T14:00:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 });
  const r = await computeDayPnl({
    positions: [SMH], ledgerText: ledger, now: MON,
    getQuotes: quoter([quote('SMH', 567.55, 595.00)]),
  });
  assert.ok(Math.abs(r.unrealized_today - (567.55 - 595.00) * 203) < 0.01, 'carried keeps prevClose basis');
  assert.strictEqual(r.per_position[0].day_basis, 'prev_close');
});

test('a lot opened TODAY still uses entry basis when the ledger knows it', async () => {
  const ledger = row({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'SMH', qty: 203, entry: 575.22 });
  const r = await computeDayPnl({
    positions: [SMH], ledgerText: ledger, now: MON,
    getQuotes: quoter([quote('SMH', 567.55, 595.00)]),
  });
  assert.ok(Math.abs(r.unrealized_today - SMH.unrealized_pl) < 0.01);
  assert.strictEqual(r.per_position[0].day_basis, 'entry');
});

test('the whole 2026-08-18 book reconciles to the true day, not the inflated one', async () => {
  const positions = [
    { symbol: 'QQQ', qty: 80, current_price: 718.57, unrealized_pl: -972.52 },
    { symbol: 'SPY', qty: 76, current_price: 768.43, unrealized_pl: -394.85 },
    SMH,
    { symbol: 'GLD', qty: 290, current_price: 399.97, unrealized_pl: (399.97 - 399.76) * 290 },
  ];
  const ledger = [   // carried pair known; today's pair absent, as on :4178
    row({ ts: '2026-08-17T13:39:00Z', event: 'entry', symbol: 'QQQ', qty: 80, entry: 730.72 }),
    row({ ts: '2026-08-17T17:32:00Z', event: 'entry', symbol: 'SPY', qty: 76, entry: 773.63 }),
  ].join('\n');
  const r = await computeDayPnl({
    positions, ledgerText: ledger, now: MON,
    getQuotes: quoter([quote('QQQ', 718.57, 729.98), quote('SPY', 768.43, 772.65),
                       quote('SMH', 567.55, 595.00), quote('GLD', 399.97, 405.90)]),
  });
  const inflated = -912.80 - 320.72 + (567.55 - 595.00) * 203 + (399.97 - 405.90) * 290;
  assert.ok(r.unrealized_today > inflated + 3000,
    `must not reproduce the -$8.6k screen figure (inflated ${inflated.toFixed(0)}, got ${r.unrealized_today})`);
  assert.ok(Math.abs(r.unrealized_today - (-912.80 - 320.72 - 1556.51 + 60.90)) < 60, `got ${r.unrealized_today}`);
});
