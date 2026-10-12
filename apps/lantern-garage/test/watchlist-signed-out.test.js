'use strict';
/**
 * test/watchlist-signed-out.test.js — a signed-out visitor cannot change the list every
 * signed-out visitor shares (2026-10-11).
 *
 * Watchlist add/remove is exempt from the trade gate (server.js, #guest-watchlist) and the
 * route keys the list on the session's user id. A signed-out request has none, so the store
 * filed its write under "default" — the one list every signed-out visitor is shown on the
 * public trader page. One visitor's add or remove changed everyone's, and each add put one
 * more symbol on the collectors' rounds (watchlistStore.allTickers). The real route runs here
 * against a recording store, so no list file is touched.
 *
 * Run: node --test apps/lantern-garage/test/watchlist-signed-out.test.js
 */
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.LANTERN_TEST_AUTH_TOKEN;   // identity comes from the session alone
const writes = [];
const store = {
  getWatchlist: (uid) => (uid ? ['SPY', 'AAPL'] : ['SPY', 'QQQ']),
  addTicker: (uid, s) => { writes.push(['add', uid, s]); return ['SPY', s]; },
  removeTicker: (uid, s) => { writes.push(['remove', uid, s]); return ['SPY']; },
};
let route;
before(() => {
  require.cache[require.resolve('../lib/watchlist-store')] = { id: 'stub', loaded: true, exports: store };
  route = require('../routes/trading/watchlist');
});

async function call(method, pathname, { user = null, body = null } = {}) {
  const sent = {};
  const ctx = {
    sendJson: (_res, payload, status) => { sent.status = status; sent.body = payload; },
    collectRequestBody: async () => (body ? JSON.stringify(body) : ''),
    traderAgent: { validateSymbol: async (s) => ({ valid: true, symbol: s }), clearCache() {} },
  };
  const req = { method, headers: {}, session: user ? { user } : {} };
  const handled = await route(req, {}, new URL('http://x' + pathname), ctx);
  return { handled, ...sent };
}

test('signed out: adding or removing is refused, and the shared list is not written', async () => {
  writes.length = 0;
  const add = await call('POST', '/api/trading/watchlist', { body: { ticker: 'GME' } });
  assert.strictEqual(add.status, 401);
  assert.deepStrictEqual(add.body, { error: 'sign in to keep your own watchlist', signin: true });
  const del = await call('DELETE', '/api/trading/watchlist/SPY');
  assert.strictEqual(del.status, 401);
  assert.deepStrictEqual(writes, [], 'nothing reached the store');
});

test('signed out: the starter list is still read', async () => {
  const r = await call('GET', '/api/trading/watchlist');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { watchlist: ['SPY', 'QQQ'] });
});

test('signed in, free accounts included: your own list, as before', async () => {
  writes.length = 0;
  const user = { id: 'u-free-1', role: 'guest' };
  const add = await call('POST', '/api/trading/watchlist', { user, body: { ticker: 'AAPL' } });
  assert.strictEqual(add.status, 200);
  const del = await call('DELETE', '/api/trading/watchlist/AAPL', { user });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(writes, [['add', 'u-free-1', 'AAPL'], ['remove', 'u-free-1', 'AAPL']]);
});

test('the pages say so instead of failing quietly, and a slot changes only once its symbol is listed', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(page, /const SIGN_IN_FOR_LIST = 'Sign in to keep your own watchlist\.';/);
  const commit = page.slice(page.indexOf('async function commitSlotSymbol(oldTicker, sym){'), page.indexOf('// ── Symbol-search popup'));
  assert.ok(commit.indexOf("if(r.status === 401){ _alertToast(SIGN_IN_FOR_LIST); return; }") > 0);
  assert.ok(commit.indexOf('if(r.status === 401)') < commit.indexOf('chartSlots[i]=sym'), 'the refusal comes before the slot changes');
  const add = page.slice(page.indexOf('async function addWatchlistSymbol(sym){'), page.indexOf('/* The AI toggle on a watchlist row'));
  assert.match(add, /if\(r\.status === 401\)\{ _alertToast\(SIGN_IN_FOR_LIST\); return; \}/);
  const explore = fs.readFileSync(path.join(__dirname, '..', 'public', 'explore.html'), 'utf8');
  assert.match(explore, /if \(r\.status === 401\) \{ btn\.disabled = false; alert\('Sign in to keep your own watchlist\.'\); return; \}/);
});
