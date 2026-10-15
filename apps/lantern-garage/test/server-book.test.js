'use strict';
/**
 * test/server-book.test.js — a request without a broker of its own is never answered from
 * the server's own brokerage session (2026-10-11).
 *
 * The legacy agent and a bare `new IbkrCpapi()` read the env IBKR client — the operator's
 * book wherever its gateway is signed in. lib/trading-api-bridge refuses it to a real user
 * and lib/alpaca-adapter closed the same hole for Alpaca (#2546); five read routes still
 * fell back to it. This pins the rule (admin or the operator profile only) and that each of
 * the five asks it BEFORE reading that book.
 *
 * Run: node --test apps/lantern-garage/test/server-book.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

function loadWith({ admin = false, ibkr = [], alpaca = [] } = {}) {
  const stub = (name, exports) => {
    const id = require.resolve(path.join(LIB, name));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('auth-middleware', { isAdmin: () => admin });
  stub('ibkr-credentials', { has: (u) => ibkr.includes(u) });
  stub('alpaca-credentials', { has: (u) => alpaca.includes(u) });
  const id = require.resolve(path.join(LIB, 'server-book'));
  delete require.cache[id];
  return require(id);
}
function restore() {
  for (const n of ['auth-middleware', 'ibkr-credentials', 'alpaca-credentials', 'server-book']) {
    delete require.cache[require.resolve(path.join(LIB, n))];
  }
}

test('only an admin or the operator profile may read the server’s book', () => {
  try {
    const prev = process.env.TRADER_OPERATOR_UID;
    delete process.env.TRADER_OPERATOR_UID;
    let sb = loadWith({ admin: true });
    assert.strictEqual(sb.mayReadServerBook({}, 'u-anyone'), true, 'an admin');
    sb = loadWith({ admin: false });
    assert.strictEqual(sb.mayReadServerBook({}, 'u-pro-user'), false, 'a signed-in Pro user');
    assert.strictEqual(sb.mayReadServerBook({}, null), false, 'a guest — the public zones read');
    assert.strictEqual(sb.mayReadServerBook({}, 'local-owner'), true, 'the operator identity the routes use');
    process.env.TRADER_OPERATOR_UID = 'u-operator';
    assert.strictEqual(sb.mayReadServerBook({}, 'u-operator'), true, 'a configured operator profile');
    assert.strictEqual(sb.mayReadServerBook({}, 'local-owner'), false, 'and only that one');
    if (prev === undefined) delete process.env.TRADER_OPERATOR_UID; else process.env.TRADER_OPERATOR_UID = prev;
  } finally { restore(); }
});

test('the answer says which is true: no broker at all, or one that did not answer', () => {
  try {
    const sb = loadWith({ ibkr: ['u-ib'], alpaca: ['u-al'] });
    assert.deepStrictEqual(sb.noServerBook('u-none'),
      { available: false, no_broker: true, reason: 'no broker connected', positions: [], account: {} });
    for (const u of ['u-ib', 'u-al']) {
      const r = sb.noServerBook(u);
      assert.strictEqual(r.no_broker, false, u + ' has a broker of their own');
      assert.strictEqual(r.reason, 'your broker did not answer');
    }
  } finally { restore(); }
});

// ── Each route asks before it reads ─────────────────────────────────────────────────
const MARKET = read('routes/trading/market.js');
const ORDERS = read('routes/trading/orders.js');
const MISC = read('routes/trading/misc.js');
const PAGE = read('public/stock-trader.html');
const between = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

test('/positions: the legacy agent is reached only after the rule', () => {
  const route = between(MARKET, "url.pathname === '/api/trading/positions' && req.method === 'GET'", '/api/trading/portfolio/history?range=1D');
  const ask = route.indexOf('sb.mayReadServerBook(req, _uid)');
  assert.ok(ask > 0, 'the route asks');
  assert.ok(ask < route.indexOf('await traderAgent.getPositions()'), 'before the legacy agent');
  assert.match(route, /sendJson\(res, sb\.noServerBook\(_uid\), 200\)/);
});

test('/zones (public): a ticker carries a position only for a reader who may see the book', () => {
  const route = between(MARKET, "let positions = [];", 'const reshaped = {};');
  assert.ok(route.indexOf('mayReadServerBook(req, getEffectiveUserId(req))') < route.indexOf('traderAgent.getPositions()'));
});

test('/portfolio/history: neither the env IBKR history nor the server’s session rows for anyone else', () => {
  const route = between(MARKET, "url.pathname === '/api/trading/portfolio/history'", 'sendJson(res, out');
  assert.match(route, /if \(_serverBook && \(!out \|\| out\.ok === false\)\) \{\s*\n\s*try \{\s*\n\s*const IbkrCpapi/);
  assert.match(route, /if \(_serverBook && \(!out \|\| out\.ok === false \|\| !Array\.isArray\(out\.timestamps\)/);
});

test('/orders: no legacy agent and no server-wide manual ledger for a user without their own', () => {
  const route = between(ORDERS, "url.pathname === '/api/trading/orders' && req.method === 'GET'", "console.error('[Trading] /orders error:'");
  const ask = route.indexOf('mayReadServerBook(req, uid)');
  assert.ok(ask > 0 && ask < route.indexOf('traderAgent.getOrders(') && ask < route.indexOf('tradingStore.listOrders('));
});

test('/status: the server account is redacted for everyone else', () => {
  const route = between(MISC, "url.pathname === '/api/trading/status'", 'return true;');
  assert.match(route, /mayReadServerBook\(req, uid\)/);
  assert.match(route, /data\.apis\.ibkr = \{ connected: false, status: null, account: null, positions: \[\], restricted: 'server account' \}/);
});

test('the page says "no broker connected", not "the broker could not be reached"', () => {
  // The STALE badge and the "backend unreachable" toast are for an outage. Having no
  // broker is not one, and saying so sent people looking for a fault that did not exist.
  const handler = PAGE.slice(PAGE.indexOf("if (d && d.available === false) {"), PAGE.indexOf('_brokerOk = true; _refreshTradeGate();'));
  assert.ok(handler.indexOf('if (d.no_broker) { _accountNoBroker(); return; }') < handler.indexOf("_accountDegraded('backend'"));
  const fn = PAGE.slice(PAGE.indexOf('function _accountNoBroker(){'), PAGE.indexOf('function _accountFresh(){'));
  assert.match(fn, /staleBadge/, 'a stale badge left over from an outage is removed');
  assert.match(fn, /<a href="\/settings\.html#connections">Connect one in Settings<\/a>/);
  assert.doesNotMatch(fn, /_alertToast/, 'and no outage toast');
});
