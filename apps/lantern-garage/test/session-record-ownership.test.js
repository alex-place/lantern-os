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
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildSessionRecord } = require('../lib/session-record');

// Mirrors the production expression at the call site in auto-trader.js.
const mine = (heldPos, ourSyms) => Object.values(heldPos).filter((p) => {
  const k = String(p && p.symbol || '').toUpperCase();
  if (!(Math.abs(Number(p && p.qty) || 0) > 0)) return false;
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
