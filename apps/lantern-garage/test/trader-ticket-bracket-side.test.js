'use strict';
/**
 * test/trader-ticket-bracket-side.test.js — the order ticket refuses an exit on the wrong
 * side of the entry (QA, 2026-09-14).
 *
 * A take-profit below a buy's entry, or a stop loss above it (the mirror for a sell), is
 * already "hit" when the order fills and would close the position the moment it opened.
 * The ticket accepted 700 / 720 around a 714.88 buy and sent them.
 *
 * Run: node --test apps/lantern-garage/test/trader-ticket-bracket-side.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const start = PAGE.indexOf('async function submitOrderTicket(){');
const end = PAGE.indexOf('let _otArmed=false, _otArmTimer=null;', start);
assert.ok(start > 0 && end > start, 'submitOrderTicket not found');
const SRC = PAGE.slice(start, end);

// One ticket, rapid mode (no arm step), with the values a user typed.
function ticket({ side = 'buy', type = 'market', entry = 714.88, limit = '', qty = '1', tp = '', sl = '' }) {
  const els = {
    otQty: { value: qty }, otLimitPrice: { value: limit },
    otTpEnabled: { checked: tp !== '' }, otTpPrice: { value: tp },
    otSlEnabled: { checked: sl !== '' }, otSlPrice: { value: sl },
    otSubmit: { textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {} } },
  };
  const out = { toasts: [], sent: [] };
  const document = { getElementById: (id) => els[id] };
  const fetch = async (url, opts) => { out.sent.push(JSON.parse(opts.body)); return { ok: true, statusText: 'OK', json: async () => ({ status: 'placed', mode: 'paper' }) }; };
  const fn = new Function('document', 'fetch', '_alertToast', 'otTicker', 'otSide', 'otOrderType', 'otCurrentPrice', 'getCurrentPrice', 'fmt',
    '_rapid', 'localStorage', 'journalLog', 'closeOrderTicket', 'refreshAfterOrder', '_orderToast',
    'let _otArmed=false, _otArmTimer=null, _lastQty=1;\n' + SRC + '\nreturn submitOrderTicket;')(
    document, fetch, (m) => out.toasts.push(m), 'QQQ', side, type,
    () => (type === 'limit' && Number(limit) > 0 ? Number(limit) : entry), () => entry, (n) => Number(n).toFixed(2),
    true, { setItem() {} }, () => {}, () => {}, () => {}, () => {});
  return { run: fn, out };
}

test('a buy with the take-profit below the entry is refused, nothing is sent', async () => {
  const t = ticket({ side: 'buy', tp: '700', sl: '710' });
  await t.run();
  assert.strictEqual(t.out.sent.length, 0);
  assert.match(t.out.toasts[0], /Take profit must be above the entry \(\$714\.88\) for a buy/);
});

test('a buy with the stop loss above the entry is refused', async () => {
  const t = ticket({ side: 'buy', tp: '720', sl: '720' });
  await t.run();
  assert.strictEqual(t.out.sent.length, 0);
  assert.match(t.out.toasts[0], /Stop loss must be below the entry \(\$714\.88\) for a buy/);
});

test('a sell is the mirror: take-profit below, stop above', async () => {
  const wrong = ticket({ side: 'sell', tp: '720', sl: '700' });
  await wrong.run();
  assert.strictEqual(wrong.out.sent.length, 0);
  assert.match(wrong.out.toasts[0], /Take profit must be below the entry .* for a sell/);
  const right = ticket({ side: 'sell', tp: '700', sl: '720' });
  await right.run();
  assert.deepStrictEqual(right.out.toasts, []);
  assert.strictEqual(right.out.sent.length, 1);
  assert.strictEqual(right.out.sent[0].takeProfit, 700);
  assert.strictEqual(right.out.sent[0].stopLoss, 720);
});

test('a bracket on the right side goes through unchanged', async () => {
  const t = ticket({ side: 'buy', tp: '720', sl: '710' });
  await t.run();
  assert.deepStrictEqual(t.out.toasts, []);
  assert.deepStrictEqual(t.out.sent[0], { ticker: 'QQQ', side: 'buy', qty: 1, type: 'market', takeProfit: 720, stopLoss: 710 });
});

test('a limit order measures the exits against the limit price, not the live one', async () => {
  // Live 714.88, limit 710: a 712 take-profit is above the entry the order will fill at.
  const t = ticket({ side: 'buy', type: 'limit', limit: '710', tp: '712', sl: '705' });
  await t.run();
  assert.deepStrictEqual(t.out.toasts, []);
  assert.strictEqual(t.out.sent[0].limitPrice, 710);
});

test('no exits, or exits switched off, are not judged at all', async () => {
  const t = ticket({ side: 'buy' });
  await t.run();
  assert.deepStrictEqual(t.out.toasts, []);
  assert.strictEqual(t.out.sent.length, 1);
  assert.strictEqual('takeProfit' in t.out.sent[0], false);
});
