'use strict';
/**
 * test/trader-ticket-exit-required.test.js — an exit the reader switched ON either reaches
 * the broker or stops the order (QA, 2026-09-16).
 *
 * `if(sl > 0) body.stopLoss = sl` meant an empty or non-positive price field silently
 * dropped the exit and sent a bare order — with the checkbox still ticked, which is the
 * reader's only evidence they are protected. Two ordinary ways in:
 *
 *   1. clear the price field to retype it, then send;
 *   2. tick the box before the first quote arrives — otSyncFromTicks anchors on
 *      otCurrentPrice(), so with no price a buy's stop auto-filled at 0 − 50 ticks
 *      = −0.50, which is ≤ 0 and was therefore dropped. Measured in the browser.
 *
 * Its sibling trader-ticket-bracket-side.test.js covers exits on the WRONG SIDE of the
 * entry; this file covers exits that are not there at all. The harness differs in one
 * way that matters: the checkbox is set independently of the price, because "ticked and
 * empty" is precisely the state that was broken.
 *
 * Run: node --test apps/lantern-garage/test/trader-ticket-exit-required.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to, what) => {
  const a = PAGE.indexOf(from), b = PAGE.indexOf(to, a);
  assert.ok(a > 0 && b > a, what + ' not found');
  return PAGE.slice(a, b);
};
const SRC = slice('async function submitOrderTicket(){', 'let _otArmed=false, _otArmTimer=null;', 'submitOrderTicket');

/** One ticket in rapid mode (no arm step). `tpOn`/`slOn` are independent of the prices. */
function ticket({ side = 'buy', type = 'market', entry = 714.88, limit = '', qty = '1',
                  tp = '', sl = '', tpOn = tp !== '', slOn = sl !== '' } = {}) {
  const focused = [];
  const el = (id, v) => ({ value: v, focus() { focused.push(id); } });
  const els = {
    otQty: { value: qty }, otLimitPrice: el('otLimitPrice', limit),
    otTpEnabled: { checked: tpOn }, otTpPrice: el('otTpPrice', tp),
    otSlEnabled: { checked: slOn }, otSlPrice: el('otSlPrice', sl),
    otSubmit: { textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {} } },
  };
  const out = { toasts: [], sent: [], focused };
  const document = { getElementById: (id) => els[id] };
  const fetch = async (url, opts) => { out.sent.push(JSON.parse(opts.body)); return { ok: true, statusText: 'OK', json: async () => ({ status: 'placed', mode: 'paper' }) }; };
  const run = new Function('document', 'fetch', '_alertToast', 'otTicker', 'otSide', 'otOrderType', 'otCurrentPrice', 'getCurrentPrice', 'fmt',
    '_rapid', 'localStorage', 'journalLog', 'closeOrderTicket', 'refreshAfterOrder', '_orderToast',
    'let _otArmed=false, _otArmTimer=null, _lastQty=1;\n' + SRC + '\nreturn submitOrderTicket;')(
    document, fetch, (m) => out.toasts.push(m), 'QQQ', side, type,
    () => (type === 'limit' && Number(limit) > 0 ? Number(limit) : entry), () => entry, (n) => Number(n).toFixed(2),
    true, { setItem() {} }, () => {}, () => {}, () => {}, () => {});
  return { run, out };
}

test('a stop loss switched on with an empty price stops the order', async () => {
  const t = ticket({ side: 'buy', slOn: true, sl: '' });
  await t.run();
  assert.strictEqual(t.out.sent.length, 0, 'a bare order went out under a ticked stop-loss box');
  assert.match(t.out.toasts[0], /Enter a stop loss price, or switch stop loss off/);
  assert.deepStrictEqual(t.out.focused, ['otSlPrice'], 'the reader is not shown which field to fix');
});

test('a take profit switched on with an empty price stops the order', async () => {
  const t = ticket({ side: 'buy', tpOn: true, tp: '' });
  await t.run();
  assert.strictEqual(t.out.sent.length, 0);
  assert.match(t.out.toasts[0], /Enter a take profit price, or switch take profit off/);
});

test('a non-positive price is refused too — that is the shape the auto-fill produced', async () => {
  // With no quote, a buy's stop auto-filled at -0.50. It must not read as "no stop asked for".
  for (const bad of ['-0.50', '0', '', '   ', 'abc']) {
    const t = ticket({ side: 'buy', slOn: true, sl: bad });
    await t.run();
    assert.strictEqual(t.out.sent.length, 0, 'sent with a stop of ' + JSON.stringify(bad));
    assert.match(t.out.toasts[0], /Enter a stop loss price/, 'silent for ' + JSON.stringify(bad));
  }
});

test('the exits still reach the broker when they are real', async () => {
  const t = ticket({ side: 'buy', tp: '720', sl: '710' });
  await t.run();
  assert.deepStrictEqual(t.out.toasts, [], 'a good bracket must not be refused');
  assert.deepStrictEqual(t.out.sent[0], { ticker: 'QQQ', side: 'buy', qty: 1, type: 'market', takeProfit: 720, stopLoss: 710 });
});

test('an exit switched OFF is not asked for a price, whatever is left in the field', async () => {
  // Unticking must not strand the order: the stale value in the disabled input is ignored.
  const t = ticket({ side: 'buy', slOn: false, sl: '710', tpOn: false, tp: '720' });
  await t.run();
  assert.deepStrictEqual(t.out.toasts, []);
  assert.strictEqual(t.out.sent.length, 1);
  assert.strictEqual('stopLoss' in t.out.sent[0], false);
  assert.strictEqual('takeProfit' in t.out.sent[0], false);
});

test('the tick sync does not invent a price before the first quote', () => {
  const SYNC = slice('function otSyncFromTicks(kind){', '\nfunction otSyncFromPrice', 'otSyncFromTicks');
  const mk = (price, side) => {
    const els = { otSlTicks: { value: '50' }, otSlPrice: { value: 'untouched' }, otTpTicks: { value: '50' }, otTpPrice: { value: 'untouched' } };
    const fn = new Function('document', 'otCurrentPrice', 'otSide', 'TICK_SIZE', 'renderOrderTicket',
      SYNC + '\nreturn otSyncFromTicks;')({ getElementById: (id) => els[id] }, () => price, side, 0.01, () => {});
    return { fn, els };
  };
  const none = mk(0, 'buy');
  none.fn('sl');
  assert.strictEqual(none.els.otSlPrice.value, '', 'a stop was invented with no price to anchor it');
  const live = mk(200, 'buy');
  live.fn('sl');
  assert.strictEqual(live.els.otSlPrice.value, '199.50', '50 ticks below a 200 buy');
  const tp = mk(200, 'buy');
  tp.fn('tp');
  assert.strictEqual(tp.els.otTpPrice.value, '200.50');
});
