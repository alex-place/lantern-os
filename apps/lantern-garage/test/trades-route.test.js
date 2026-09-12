'use strict';
/**
 * test/trades-route.test.js — #3558.
 *
 * The list is per-reader and paged on the server, so what matters here is that it reads
 * the right book, that a guest gets the same simulated rows the rest of their journal is
 * drawn from, and that a hostile query string cannot ask for the whole ledger.
 *
 * Run: node --test apps/lantern-garage/test/trades-route.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-route-'));
const LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LOG;

const route = require('../routes/trading/trades');

let n = 0;
const row = (o) => {
  n += 1;
  return Object.assign({
    ts: '2026-09-0' + (1 + (n % 9)) + 'T18:00:00.000Z', user: 'u-1', event: 'exit',
    symbol: 'SPY', qty: 10, entry: 100 + n * 0.001, exit: 105, pnl: 50, pnl_pct: 5,
    reason: 'signal_exit', status: 'filled', order_id: 'o' + n,
  }, o);
};

function seed(rows) { fs.writeFileSync(LOG, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }

function call(qs, { userId = 'u-1' } = {}) {
  const url = new URL('http://x/api/trading/trades' + (qs || ''));
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {}, url: url.pathname + url.search });
  if (userId != null) req.session = { user: { id: userId } };
  const out = {};
  const ctx = { sendJson: (res, obj, code) => { out.json = obj; out.status = code || 200; } };
  return route(req, {}, url, ctx).then((handled) => ({ handled, ...out }));
}

test('a non-matching path or method declines, so other routes still see the request', async () => {
  const other = new URL('http://x/api/trading/positions');
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {} });
  assert.strictEqual(await route(req, {}, other, { sendJson: () => {} }), false);

  const post = new URL('http://x/api/trading/trades');
  const preq = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, socket: {} });
  assert.strictEqual(await route(preq, {}, post, { sendJson: () => {} }), false);
});

test('it returns this reader\'s trades and nobody else\'s', async () => {
  seed([
    row({ user: 'u-1', symbol: 'AAPL' }),
    row({ user: 'u-1', symbol: 'MSFT' }),
    row({ user: 'u-2', symbol: 'SECRET' }),
  ]);
  const r = await call();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.total, 2);
  assert.ok(!JSON.stringify(r.json).includes('SECRET'), 'another account never appears');
});

test('paging, sorting and filtering come through the query string', async () => {
  seed([
    row({ symbol: 'AAPL', pnl: 300 }),
    row({ symbol: 'AAPL', pnl: -100 }),
    row({ symbol: 'MSFT', pnl: 50 }),
  ]);
  assert.strictEqual((await call('?symbol=aapl')).json.total, 2);
  assert.strictEqual((await call('?result=loss')).json.total, 1);
  const sorted = await call('?sort=pnl&dir=desc');
  assert.strictEqual(sorted.json.trades[0].pnl, 300);
  const page = await call('?limit=1&offset=1&sort=pnl&dir=desc');
  assert.deepStrictEqual([page.json.trades.length, page.json.offset, page.json.total], [1, 1, 3]);
  assert.strictEqual(page.json.trades[0].pnl, 50, 'the second-best trade');
});

test('a hostile page size cannot ask for the whole ledger', async () => {
  seed(Array.from({ length: 300 }, () => row({})));
  const r = await call('?limit=999999');
  assert.strictEqual(r.json.trades.length, 200, 'capped');
  assert.strictEqual(r.json.total, 300, 'while still saying how many there are');
});

test('a guest reads the same simulated book the rest of their journal shows', async () => {
  const r = await call('?demo=champion', { userId: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.demo, true);
  assert.strictEqual(r.json.source, 'champion-demo');
  assert.ok(r.json.total > 0, 'the demo journal is not the one empty card on the page');
  assert.ok(r.json.trades.every((t) => t.qty > 0), 'and its rows carry a size like a real book');
});

test('the demo list respects the same filters as the real one', async () => {
  const all = await call('?demo=champion', { userId: null });
  const wins = await call('?demo=champion&result=win', { userId: null });
  assert.ok(wins.json.total > 0 && wins.json.total < all.json.total);
  assert.ok(wins.json.trades.every((t) => t.pnl > 0));
});

test('an empty book is an empty list, not an error', async () => {
  seed([row({ user: 'somebody-else' })]);
  const r = await call();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.json.total, r.json.trades], [0, []]);
});

test('the reader is never named by the request', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading', 'trades.js'), 'utf8');
  assert.doesNotMatch(src, /searchParams\.get\(['"](user|userId|account)/, 'no reader id from the query');
  assert.match(src, /getEffectiveUserId\(req\)/, 'it comes from the session');
});
