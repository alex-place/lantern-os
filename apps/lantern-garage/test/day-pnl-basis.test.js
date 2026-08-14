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

// The trading-day gate: carried positions contribute $0 only when TODAY cannot
// have its own prints — weekends and the dead overnight window. The phantom the
// gate guards (the +$1,359.77 Sunday header: Friday's move re-badged as today)
// only occurs on non-trading days; on a weekday from ~04:00 ET the quote chart
// has rolled to today, prevClose is genuinely yesterday's close, and pre-market
// moves ARE today's P&L. Gating those out froze the panel against a moving book
// ("the premarket is already open why doesnt it show the p/l", 2026-08-14).
test('the gate: weekends and overnight are dead; a weekday from 04:00 ET is LIVE, pre-market included', () => {
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-09T17:34:00Z')), false, 'Sunday');
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-10T07:00:00Z')), false, 'Monday 03:00 ET — chart may still describe Friday');
  assert.strictEqual(sessionTradedToday(Date.parse('2026-08-10T12:00:00Z')), true, 'Monday 08:00 ET pre-market — today IS underway');
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
  assert.match(r.pnl_basis, /no trading day underway/);
});

test('weekday PRE-MARKET: a carried position\'s overnight move COUNTS, measured from yesterday\'s close', async () => {
  // Friday 08:00 ET. GLD carried from Thursday; IBKR marks it 399.68 → 398.20
  // pre-market. The panel must show −$1.48/sh × qty as today's move, not $0.
  const friday0800 = Date.parse('2026-08-14T12:00:00Z');
  const ledger = entry('GLD', '2026-08-13T14:00:00Z');
  const p = { symbol: 'GLD', qty: 290, current_price: 398.20, unrealized_pl: -458.20 };
  const r = await computeDayPnl({
    positions: [p], ledgerText: ledger, now: friday0800,
    getQuotes: quoter([quote('GLD', 398.20, 399.68)]),   // prevClose = Thursday's close
  });
  assert.ok(Math.abs(r.unrealized_today - (398.20 - 399.68) * 290) < 0.01,
    `pre-market move vs yesterday close, got ${r.unrealized_today}`);
  assert.match(r.pnl_basis, /pre-market marks/, 'the basis names the pre-market state');
});

test('overnight dead zone (03:00 ET weekday): still $0 — the chart may describe yesterday', async () => {
  const friday0300 = Date.parse('2026-08-14T07:00:00Z');
  const ledger = entry('GLD', '2026-08-13T14:00:00Z');
  const p = { symbol: 'GLD', qty: 290, current_price: 399.68, unrealized_pl: 100 };
  const r = await computeDayPnl({
    positions: [p], ledgerText: ledger, now: friday0300,
    getQuotes: quoter([quote('GLD', 399.68, 404.66)]),   // stale: still Thursday's chg
  });
  assert.strictEqual(r.unrealized_today, 0, 'no prints yet → no move to attribute');
});

test('a carried lot EXITED pre-market attributes only its pre-market leg (protective-mode shape)', async () => {
  // The 04:05-style protective exit: carried GLD sold at 04:05+ ET. Realized
  // must be exit − yesterday close, not exit − entry.
  const friday0800 = Date.parse('2026-08-14T12:00:00Z');
  const ledger = [
    entry('GLD', '2026-08-13T14:00:00Z'),
    row({ ts: '2026-08-14T08:05:00Z', event: 'exit', symbol: 'GLD', qty: 290, entry: 399.78, exit: 398.90, pnl: -255.20 }),
  ].join('\n');
  const r = await computeDayPnl({
    positions: [], ledgerText: ledger, now: friday0800,
    getQuotes: quoter([quote('GLD', 398.90, 399.68)]),
  });
  assert.ok(Math.abs(r.realized_today - (398.90 - 399.68) * 290) < 0.01,
    `pre-market exit vs yesterday close, got ${r.realized_today}`);
});

// ── prevClose from the bar cache (the 04:42 live failure) ────────────────────
// Yahoo's 1d chart rolls per-symbol at an undocumented hour; at 04:42 ET it was
// still serving WEDNESDAY as "previous close" (SPXS day showed −$1,186 against
// a 24.04 reference). The bar cache is ours and deterministic.
const { prevCloseFromBarsFactory } = require('../lib/day-pnl');
const fsx = require('fs');
const osx = require('os');
const pathx = require('path');

function barsDirWith(sym, bars) {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'bars-'));
  fsx.writeFileSync(pathx.join(dir, sym + '-5m.jsonl'), bars.map((b) => JSON.stringify(b)).join('\n'));
  return dir;
}

test('bar-cache prevClose = last PRIOR session, official close — not post prints, not today', () => {
  const dir = barsDirWith('SOXS', [
    { t: '2026-08-12T19:55:00Z', c: 40.68 },   // Wednesday 15:55 ET
    { t: '2026-08-13T19:55:00Z', c: 39.78 },   // Thursday 15:55 ET — THE official close
    { t: '2026-08-13T21:00:00Z', c: 40.05 },   // Thursday 17:00 ET post print — belongs to Friday's move
    { t: '2026-08-14T12:00:00Z', c: 40.12 },   // Friday 08:00 ET pre — today, must be skipped
  ]);
  const get = prevCloseFromBarsFactory(dir);
  const friday = Date.parse('2026-08-14T12:30:00Z');
  assert.strictEqual(get('SOXS', friday), 39.78, 'Thursday 16:00 close, not the 17:00 post print');
  assert.strictEqual(get('MISSING', friday), null, 'no cache → null, caller falls back');
});

test('the 16:00-STAMPED bar is the first post-auction bar, not the close (GLD 398.71 vs 399.59)', () => {
  const dir = barsDirWith('GLD', [
    { t: '2026-08-13T19:55:00Z', c: 399.59 },  // 15:55 ET — last bar BEGINNING in-session
    { t: '2026-08-13T20:00:00Z', c: 398.71 },  // 16:00 ET — starts AT the close = post bar
    { t: '2026-08-14T12:00:00Z', c: 398.96 },
  ]);
  const get = prevCloseFromBarsFactory(dir);
  assert.strictEqual(get('GLD', Date.parse('2026-08-14T12:30:00Z')), 399.59,
    'bars are start-stamped: minute 960 is already outside the session');
});

test('TORN READ: a truncated view ending weeks back returns null, never a stale close', () => {
  // The collector rewrites bar files; a read mid-rewrite saw GLD end at July 15
  // and the factory served 372.19 as "yesterday's close" (live 2026-08-14).
  const dir = barsDirWith('GLD', [
    { t: '2026-07-15T19:55:00Z', c: 372.19 },
    { t: '2026-07-15T20:10:00Z', c: 372.23 },
  ]);
  const get = prevCloseFromBarsFactory(dir);
  assert.strictEqual(get('GLD', Date.parse('2026-08-14T12:30:00Z')), null,
    'a "last session" 30 days old is a torn read, not a reference');
});

test('a torn read is not memoized — the next call sees the finished rewrite', () => {
  const dir = barsDirWith('GLD', [
    { t: '2026-07-15T19:55:00Z', c: 372.19 },  // truncated view first
  ]);
  const get = prevCloseFromBarsFactory(dir);
  const friday = Date.parse('2026-08-14T12:30:00Z');
  assert.strictEqual(get('GLD', friday), null, 'first read: truncated → null');
  // the rewrite completes between polls
  fsx.appendFileSync(pathx.join(dir, 'GLD-5m.jsonl'),
    '\n' + JSON.stringify({ t: '2026-08-13T19:55:00Z', c: 399.59 }));
  assert.strictEqual(get('GLD', friday), 399.59, 'second read must see the real file, not a pinned null');
  assert.strictEqual(get('GLD', friday), 399.59, 'good answers ARE memoized');
});

test('the 04:42 shape end-to-end: stale quote reference loses to the bar cache', async () => {
  // getQuotes returns the not-yet-rolled quote (price = Thursday post print,
  // chg vs WEDNESDAY). Without the bar cache this books Thursday's move as
  // today; with it, today's move is measured from Thursday's true close.
  const friday0800 = Date.parse('2026-08-14T12:00:00Z');
  const dir = barsDirWith('SPXS', [
    { t: '2026-08-13T19:55:00Z', c: 23.55 },   // Thursday close
  ]);
  const ledger = entry('SPXS', '2026-08-13T14:00:00Z');
  const p = { symbol: 'SPXS', qty: 2467, current_price: 23.56, unrealized_pl: 60 };
  const r = await computeDayPnl({
    positions: [p], ledgerText: ledger, now: friday0800,
    getQuotes: quoter([quote('SPXS', 23.56, 24.0583)]),          // stale: references Wednesday
    getPrevClose: prevCloseFromBarsFactory(dir),
  });
  assert.ok(Math.abs(r.unrealized_today - (23.56 - 23.55) * 2467) < 0.01,
    `must use Thursday's close (got ${r.unrealized_today}, stale ref would give ${((23.56 - 24.0583) * 2467).toFixed(0)})`);
});

test('bar cache empty for the symbol → quote-derived reference still works (fallback intact)', async () => {
  const friday0800 = Date.parse('2026-08-14T12:00:00Z');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'bars-empty-'));
  const ledger = entry('GLD', '2026-08-13T14:00:00Z');
  const p = { symbol: 'GLD', qty: 290, current_price: 398.20, unrealized_pl: -458 };
  const r = await computeDayPnl({
    positions: [p], ledgerText: ledger, now: friday0800,
    getQuotes: quoter([quote('GLD', 398.20, 399.68)]),
    getPrevClose: prevCloseFromBarsFactory(dir),
  });
  assert.ok(Math.abs(r.unrealized_today - (398.20 - 399.68) * 290) < 0.01, `got ${r.unrealized_today}`);
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
