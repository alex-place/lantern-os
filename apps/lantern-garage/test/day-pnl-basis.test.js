'use strict';

/**
 * day-pnl-basis.test.js — Day P&L must be TODAY's P&L (2026-08-08).
 *
 * Two live inaccuracies, both reported by the operator as "the P&L is wrong":
 *
 * 1. UTC day roll: "today" was the UTC date, so from 20:00 ET the realized
 *    filter looked for fills dated tomorrow and the session's realized losses
 *    vanished from the figure at midnight UTC.
 * 2. Since-entry unrealized: with positions carried overnight, adding full
 *    since-entry unrealized re-counts every prior day's move each new day.
 *    Correct: today-opened → mark − entry; carried → mark − prevClose.
 *
 * These drove the REAL module (lib/day-pnl.js) as of #3283. They were mirrors
 * of expressions inlined in routes/trading/market.js — which is precisely how
 * the realized term kept its whole-lot basis while the mirrors stayed green.
 * A test that re-implements the code under test cannot fail with it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { computeDayPnl, sessionTradedToday, etDay } = require('../lib/day-pnl');

const row = (o) => JSON.stringify(o);
const quote = (ticker, price, prev) => ({ ticker, price, chg_pct: ((price - prev) / prev) * 100 });
const quoter = (list) => async (syms) => list.filter((q) => syms.includes(q.ticker));
const entry = (sym, ts) => row({ ts, event: 'entry', symbol: sym, qty: 1, entry: 1 });

test('a Friday 19:36 ET fill still belongs to Friday after midnight UTC', () => {
  const fill = Date.parse('2026-08-07T23:36:08Z');          // 19:36 ET Friday
  const saturdayNightUtc = Date.parse('2026-08-08T04:43:00Z'); // 00:43 ET Saturday
  assert.strictEqual(etDay(fill), '2026-08-07');
  assert.strictEqual(etDay(saturdayNightUtc), '2026-08-08');
  // The UTC comparison that produced the bug: at 20:01 ET Friday, UTC is
  // already the 8th — the fill's UTC date still matches, so realized survives
  // the evening; the OLD code compared against the UTC "today" and dropped it.
  const fridayEvening = Date.parse('2026-08-08T00:01:00Z');  // 20:01 ET Friday
  assert.strictEqual(etDay(fridayEvening), '2026-08-07', 'evening is still the same ET session');
});

test('a Friday fill is still counted at 20:01 ET, not dropped by the UTC roll', async () => {
  const friday2001 = Date.parse('2026-08-08T00:01:00Z');
  const ledger = [
    entry('QQQ', '2026-08-07T14:00:00Z'),
    row({ ts: '2026-08-07T23:36:08Z', event: 'exit', symbol: 'QQQ', qty: 10, entry: 100, exit: 90, pnl: -654.42 }),
  ].join('\n');
  const r = await computeDayPnl({ positions: [], ledgerText: ledger, now: friday2001, getQuotes: quoter([]) });
  assert.strictEqual(r.realized_today, -654.42, 'the session\'s realized loss must survive the evening');
});

test('a position opened TODAY contributes its move since entry', async () => {
  const now = Date.parse('2026-08-10T18:00:00Z');   // Monday 14:00 ET
  const ledger = entry('QQQ', '2026-08-10T14:00:00Z');
  const p = { symbol: 'QQQ', qty: 39, current_price: 723.0, unrealized_pl: (723.0 - 721.68) * 39 };
  const r = await computeDayPnl({ positions: [p], ledgerText: ledger, now, getQuotes: quoter([quote('QQQ', 723.0, 719.0)]) });
  assert.ok(Math.abs(r.unrealized_today - 51.48) < 0.01, `got ${r.unrealized_today}`);
});

test('a CARRIED position contributes only today\'s move, not its whole life', async () => {
  // IWM carried from Friday: entered 300.59, prev close 301.56, mark 302.10.
  const now = Date.parse('2026-08-10T18:00:00Z');   // Monday 14:00 ET
  const ledger = entry('IWM', '2026-08-07T14:00:00Z');
  const p = { symbol: 'IWM', qty: 191, current_price: 302.10, unrealized_pl: (302.10 - 300.59) * 191 }; // +288 since entry
  const r = await computeDayPnl({ positions: [p], ledgerText: ledger, now, getQuotes: quoter([quote('IWM', 302.10, 301.56)]) });
  assert.ok(Math.abs(r.unrealized_today - (302.10 - 301.56) * 191) < 0.01, 'only the +0.54 move today counts');
  assert.ok(r.unrealized_today < Number(p.unrealized_pl), 'must not re-count Friday\'s gain on Monday');
});

test('no prevClose available → honest fallback to since-entry (never zero, never invented)', async () => {
  const now = Date.parse('2026-08-10T18:00:00Z');
  const ledger = entry('ZZZZ', '2026-08-07T14:00:00Z');
  const p = { symbol: 'ZZZZ', qty: 10, current_price: 100, unrealized_pl: 40 };
  const r = await computeDayPnl({ positions: [p], ledgerText: ledger, now, getQuotes: quoter([]) });
  assert.strictEqual(r.unrealized_today, 40);
  assert.strictEqual(r.degraded, true, 'the fallback must be declared, not silent');
});

// The session gate: carried positions contribute $0 when today's ET session
// hasn't traded (weekend or pre-open) — quotes still carry the LAST session's
// chg_pct then, so a prevClose-derived "move" would be Friday's move re-badged
// as today (the +$1,359.77 Sunday header, reported twice).
test('the session gate: weekend and pre-open are NOT a trading session; 09:30+ weekday is', () => {
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-09T17:34:00Z')), false, 'Sunday');
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-10T12:00:00Z')), false, 'Monday 08:00 ET pre-open');
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-10T13:31:00Z')), true, 'Monday 09:31 ET');
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-10T22:00:00Z')), true, 'Monday 18:00 ET — today DID trade');
});

test('carried + no session today = $0 contribution even with a stale chg_pct available', async () => {
  // Sunday: quote still says +0.6% (Friday's change) → naive prevClose credits
  // Friday's move. The gate must zero it regardless of what quotes claim.
  const sunday = Date.parse('2026-08-09T17:34:00Z');
  const ledger = entry('IWM', '2026-08-07T14:00:00Z');
  const p = { symbol: 'IWM', qty: 191, current_price: 301.92, unrealized_pl: 245.39 };
  const stalePrevClose = 301.92 / 1.006;
  assert.ok((p.current_price - stalePrevClose) * p.qty > 300, 'the naive figure is exactly the reported phantom');
  const r = await computeDayPnl({ positions: [p], ledgerText: ledger, now: sunday, getQuotes: quoter([quote('IWM', 301.92, stalePrevClose)]) });
  assert.strictEqual(r.unrealized_today, 0);
  assert.match(r.pnl_basis, /no session today/);
});

test('weekend shape: no ET fills today + flat marks = Day P&L ~ 0', async () => {
  // Saturday: realized(today ET)=0; carried positions mark == Friday close.
  const saturday = Date.parse('2026-08-08T16:00:00Z');
  const ledger = [entry('IWM', '2026-08-07T14:00:00Z'), entry('SMH', '2026-08-07T14:00:00Z')].join('\n');
  const positions = [
    { symbol: 'IWM', qty: 191, current_price: 301.56, unrealized_pl: 185 },
    { symbol: 'SMH', qty: 153, current_price: 187.97, unrealized_pl: 78 },
  ];
  const r = await computeDayPnl({
    positions, ledgerText: ledger, now: saturday,
    getQuotes: quoter([quote('IWM', 301.56, 301.56), quote('SMH', 187.97, 187.97)]),
  });
  assert.strictEqual(r.realized_today, 0);
  assert.ok(Math.abs(r.pnl_today) < 0.01, 'a non-trading day reads ~$0, not the open positions\' lifetime P&L');
});
