'use strict';

/**
 * session-record-ownership.test.js — a session row must describe THIS book.
 *
 * `heldPos` inside the scan is every position in the ACCOUNT, not every
 * position this engine owns. The champion book holds XMMO/SPMO and the
 * overnight sleeve holds its own; on 2026-08-13 that leak made the
 * external-close sweep reconstruct SPMO (-$199.35) and XMMO (-$107.83) exits
 * into the day-trader's ledger (#3277).
 *
 * The same trap sits under the session record: unfiltered, another book's
 * positions land in carried_out, inflate open_risk, and are marked into this
 * book's Day P&L. These pin the filter the call site applies.
 *
 * The partition (2026-10-28) comes out first: the reserve fund and the overnight
 * book's names are excluded even when this scan reads them (the book's SPY/QQQ/SMH
 * are on the tradelist), and the row lists them apart as partition_out.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildSessionRecord } = require('../lib/session-record');

// Mirrors the production expression at the call site in auto-trader.js; `fund` is its
// `_fund` set (the reserve fund + the overnight book's names).
const mine = (heldPos, ourSyms, fund = new Set()) => Object.values(heldPos).filter((p) => {
  const k = String(p && p.symbol || '').toUpperCase();
  if (!(Math.abs(Number(p && p.qty) || 0) > 0)) return false;
  if (fund.has(k)) return false;
  return !ourSyms.size || ourSyms.has(k);
});

// The exact 2026-08-13 account: four day-trader positions plus two the
// champion book owns.
const ACCOUNT_BOOK = {
  SOXS: { symbol: 'SOXS', qty: 3057.8, current_price: 39.76, unrealized_pl: 5467.70, day_pnl: 5467.70 },
  GLD: { symbol: 'GLD', qty: 290, current_price: 399.56, unrealized_pl: -64.82, day_pnl: -64.82 },
  SPMO: { symbol: 'SPMO', qty: 400, current_price: 102.5, unrealized_pl: -199.35, day_pnl: -199.35 },
  XMMO: { symbol: 'XMMO', qty: 250, current_price: 88.1, unrealized_pl: -107.83, day_pnl: -107.83 },
};
const OURS = new Set(['SOXS', 'GLD', 'SQQQ', 'SPXS']);
const NOW = Date.parse('2026-08-13T20:10:00Z');
const LEDGER = JSON.stringify({ ts: '2026-08-13T14:06:00Z', event: 'entry', symbol: 'SOXS', qty: 1, notional: 10, tier: 'B' });

test('another book\'s positions never enter carried_out', () => {
  const r = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(ACCOUNT_BOOK, OURS), dayPnl: {} });
  assert.deepStrictEqual(r.carried_out.map((p) => p.symbol), ['GLD', 'SOXS'],
    'SPMO and XMMO belong to the champion book');
});

test('open_risk counts only this book — the champion\'s losses are not ours', () => {
  const r = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(ACCOUNT_BOOK, OURS), dayPnl: {} });
  assert.strictEqual(r.open_risk, 5402.88, '5467.70 − 64.82, without the −307.18 that is not ours');
  const unfiltered = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: Object.values(ACCOUNT_BOOK), dayPnl: {} });
  assert.strictEqual(unfiltered.open_risk, 5095.7, 'what the leak would have recorded');
});

test('a zero/dust-qty row is dropped even when the symbol IS ours', () => {
  const withFlat = { ...ACCOUNT_BOOK, SQQQ: { symbol: 'SQQQ', qty: 0, current_price: 36, unrealized_pl: 0 } };
  assert.deepStrictEqual(mine(withFlat, OURS).map((p) => p.symbol).sort(), ['GLD', 'SOXS']);
});

test('an EMPTY ownership set keeps everything — never silently drop the whole book', () => {
  // _ourSyms is empty only when the scan produced no signals and there is no
  // engine state. Filtering to nothing there would erase a real book.
  assert.strictEqual(mine(ACCOUNT_BOOK, new Set()).length, 4);
});

test('ownership is case-insensitive on the symbol', () => {
  const lower = { soxs: { symbol: 'soxs', qty: 10, current_price: 39, unrealized_pl: 1 } };
  assert.strictEqual(mine(lower, OURS).length, 1);
});

// Stable 2026-10-28 at the close: the trader's TLT, the overnight book's 15:55 SPY and SMH (both scanned, both on the
// tradelist), and the reserve fund's BOXX (not scanned).
const STABLE = {
  TLT: { symbol: 'TLT', qty: 719, current_price: 80.92, unrealized_pl: -255.25 },
  SPY: { symbol: 'SPY', qty: 69, current_price: 771.92, unrealized_pl: -2.79 },
  SMH: { symbol: 'SMH', qty: 94, current_price: 567.15, unrealized_pl: -4 },
  BOXX: { symbol: 'BOXX', qty: 2285, current_price: 118.8, unrealized_pl: 68.55 },
};
const SCANNED = new Set(['TLT', 'SPY', 'SMH', 'QQQ', 'GLD']);
const FUND = new Set(['BOXX', 'SPY', 'SMH']);

test('the partition never enters carried_out or open_risk, even when the scan reads its names', () => {
  const r = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(STABLE, SCANNED, FUND), dayPnl: {} });
  assert.deepStrictEqual(r.carried_out.map((p) => p.symbol), ['TLT'], 'SPY and SMH are the overnight book\'s');
  assert.strictEqual(r.open_risk, -255.25);
  const leak = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(STABLE, SCANNED), dayPnl: {} });
  assert.deepStrictEqual(leak.carried_out.map((p) => p.symbol), ['SMH', 'SPY', 'TLT'], 'control: the scan alone lets the book through');
});

test('the partition stays out with an EMPTY ownership set too', () => {
  assert.deepStrictEqual(mine(STABLE, new Set(), FUND).map((p) => p.symbol), ['TLT']);
});

test('partition_out lists the other books apart; no partition, no field', () => {
  const theirs = Object.values(STABLE).filter((p) => FUND.has(p.symbol));
  const r = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(STABLE, SCANNED, FUND), dayPnl: {}, partition: theirs });
  assert.deepStrictEqual(r.partition_out.map((p) => [p.symbol, p.qty]), [['BOXX', 2285], ['SMH', 94], ['SPY', 69]]);
  assert.strictEqual(r.partition_out[0].unrealized, 68.55);
  const none = buildSessionRecord({ ledgerText: LEDGER, now: NOW, account: { equity: 1 }, positions: mine(STABLE, SCANNED), dayPnl: {} });
  assert.ok(!('partition_out' in none));
});
