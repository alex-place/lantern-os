'use strict';

/**
 * orders-tab-split.test.js — working orders belong on the Orders tab, with a
 * way to cancel them; everything settled belongs in history.
 *
 * Live 2026-08-14 ("the orders and order history are flipped"): the tab filter
 * accepted only ['new','accepted','pending','open','partially_filled'], so the
 * operator's four resting pre-open sells — status `submitted` from the ledger,
 * one of them a DUPLICATE that needed canceling — rendered under Order history
 * while Orders said "None". And no cancel control existed anywhere: the DELETE
 * route shipped 2026-07-26, but no UI ever called it.
 *
 * These tests run the REAL functions extracted from stock-trader.html, so they
 * fail if the page's own code regresses — not a mirror.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').split('\n');
const grab = (re) => {
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0, 'function not found: ' + re);
  let depth = 0, out = [], started = false;
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};

const src = [/^function _isWorkingOrder\(/, /^function renderOrders\(/].map(grab).join('\n');

function render(orders) {
  const els = { 'tp-orders': { innerHTML: '' }, 'tp-history': { innerHTML: '' } };
  const sandbox = {
    document: { getElementById: (id) => els[id] },
    fmt: (v, d) => Number(v).toFixed(d),
    _fmtOrderTime: () => 't',
    focusTicker: () => {},
  };
  const fn = new Function(...Object.keys(sandbox), src + '\nreturn { renderOrders, _isWorkingOrder };');
  const api = fn(...Object.values(sandbox));
  api.renderOrders(orders);
  return { open: els['tp-orders'].innerHTML, hist: els['tp-history'].innerHTML, api };
}

const ORDERS = [
  { id: '1765890034', symbol: 'SPXS', side: 'sell', qty: 2467, type: 'market', status: 'submitted' },
  { id: '1765890035', symbol: 'SPXS', side: 'sell', qty: 2467, type: 'market', status: 'submitted' },
  { id: '99001', symbol: 'SQQQ', side: 'sell', qty: 1614, type: 'stp', status: 'open', operator_account: true },
  { id: '77001', symbol: 'GLD', side: 'sell', qty: 290, type: 'market', status: 'filled' },
  { id: '77002', symbol: 'QQQ', side: 'buy', qty: 10, type: 'limit', limit_price: 700, status: 'canceled' },
  { id: '77003', symbol: 'TLT', side: 'sell', qty: 5, type: 'market', status: 'inactive' },
];

test('the flip: `submitted` rows are WORKING orders and render on the Orders tab', () => {
  const { open, hist } = render(ORDERS);
  const rowsOf = (html, sym) => (html.match(new RegExp("focusTicker\\('" + sym + "'\\)", 'g')) || []).length;
  assert.strictEqual(rowsOf(open, 'SPXS'), 2, 'both resting SPXS sells — including the duplicate — are on Orders');
  assert.strictEqual(rowsOf(hist, 'SPXS'), 0, 'and not misfiled under history');
});

test('settled rows (filled / canceled / inactive) stay in history', () => {
  const { open, hist } = render(ORDERS);
  const rowsOf = (html, sym) => (html.match(new RegExp("focusTicker\\('" + sym + "'\\)", 'g')) || []).length;
  for (const sym of ['GLD', 'QQQ', 'TLT']) {
    assert.strictEqual(rowsOf(open, sym), 0, sym + ' is settled — not a working order');
    assert.strictEqual(rowsOf(hist, sym), 1, sym + ' belongs to history');
  }
});

test('every working row gets a Cancel button wired to its own id; history rows get none', () => {
  const { open, hist } = render(ORDERS);
  assert.ok(open.includes("cancelOrder('1765890034'"), 'the first SPXS is cancellable');
  assert.ok(open.includes("cancelOrder('1765890035'"), 'the DUPLICATE is cancellable — the whole point');
  assert.ok(open.includes("cancelOrder('99001'"), 'the operator-book stop is cancellable');
  assert.ok(!/cancelOrder\(/.test(hist), 'nothing to cancel in history');
});

test('operator-book rows are marked (op) so the viewer knows whose orders these are', () => {
  const { open } = render(ORDERS);
  assert.ok(/\(op\)/.test(open), 'the operator_account flag surfaces in the row');
});

test('a row with no id renders without a broken button', () => {
  const { open } = render([{ symbol: 'X', side: 'sell', qty: 1, type: 'market', status: 'submitted' }]);
  assert.ok(!/cancelOrder\(/.test(open), 'no id → no cancel call to nowhere');
});

test('_isWorkingOrder vocabulary covers every broker/ledger working status', () => {
  const { api } = render([]);
  for (const s of ['new', 'accepted', 'pending', 'open', 'partially_filled', 'submitted', 'presubmitted', 'pending_new', 'working', 'held']) {
    assert.strictEqual(api._isWorkingOrder({ status: s }), true, s + ' is working');
  }
  for (const s of ['filled', 'canceled', 'inactive', 'rejected', 'expired', '', undefined]) {
    assert.strictEqual(api._isWorkingOrder({ status: s }), false, String(s) + ' is not working');
  }
});
