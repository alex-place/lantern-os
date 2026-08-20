// #3331 — the watchlist snapshot injected into every chat turn.
//
// Contract: it is the USER'S list in THEIR order, it forwards the caller's id on the
// loopback hop, it never throws, it says nothing at all for a signed-out user, and it
// tells the model to re-check with trader_signal rather than trusting the snapshot.
//
// http.get is stubbed at the seam the module actually uses, so this runs with no
// server and the real request-building code is still exercised.
//
// Run: node apps/lantern-garage/test/trader-context.test.js
const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');

let FIXTURE = {};
let SEEN = [];
const realGet = http.get;
http.get = (opts, cb) => {
  SEEN.push(opts);
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  const key = String(opts.path || '').split('?')[0];
  process.nextTick(() => {
    let payload;
    try { payload = FIXTURE[key]; } catch (e) { req.emit('error', e); return; }
    if (payload === undefined) { req.emit('error', new Error('no route')); return; }
    cb(res);
    res.emit('data', JSON.stringify(payload));
    res.emit('end');
  });
  return req;
};

const tc = require('../lib/trader-context');
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

const setFixture = () => {
  SEEN = [];
  FIXTURE = {
    '/api/trading/watchlist-prices': [
      { ticker: 'SPY', price: 772.4, chg_pct: -0.51 },
      { ticker: 'SOXL', price: 152.3, chg_pct: 5.07 },
      { ticker: 'TLT', price: 81.43, chg_pct: -0.74 },
    ],
    // NB: the module reads the open position from the ZONES payload (z.position) —
    // it fetches exactly two endpoints, watchlist-prices and zones, and nothing else.
    '/api/trading/zones': { zones: {
      SPY: { direction: 'BEARISH', confidence: 99 },
      SOXL: { direction: 'NEUTRAL', confidence: 58, position: { qty: 10, avg_price: 148.2 } },
    } },
  };
};
// each check uses a fresh user id — the module caches per user for 30s
let n = 0;
const uid = () => 'u-' + (++n);

(async () => {
  await check('a signed-out user gets NO injected context, and no request is made', async () => {
    setFixture();
    assert.strictEqual(await tc.watchlistContext(null), '');
    assert.strictEqual(await tc.watchlistContext(''), '');
    assert.strictEqual(SEEN.length, 0, 'a guest turn must not even hit the trading endpoints');
  });

  await check('the snapshot keeps the user\'s symbols in their order', async () => {
    setFixture();
    const out = await tc.watchlistContext(uid());
    const at = (s) => out.indexOf(s);
    assert.ok(at('SPY') < at('SOXL') && at('SOXL') < at('TLT'), 'order preserved, not re-sorted');
    assert.ok(out.includes('772.4') && out.includes('-0.51'), 'price and day change present');
  });

  await check('the caller\'s id is forwarded on the loopback hop', async () => {
    setFixture();
    await tc.watchlistContext('alice@example.com');
    assert.ok(SEEN.length > 0);
    for (const o of SEEN) {
      assert.strictEqual(o.headers['x-keystone-user'], encodeURIComponent('alice@example.com'),
        'per-user data requires the id to ride along — otherwise everyone sees one watchlist');
    }
  });

  await check('open positions and the engine direction ride along', async () => {
    setFixture();
    const out = await tc.watchlistContext(uid());
    assert.ok(/SOXL[^\n·]*HOLDING/.test(out), 'a held symbol is flagged');
    assert.ok(/SPY[^\n·]*BEARISH/.test(out), 'the engine direction is carried');
  });

  await check('it labels itself a snapshot and points at trader_signal', async () => {
    setFixture();
    const out = await tc.watchlistContext(uid());
    assert.ok(/snapshot/i.test(out), 'a 30s-old price presented as "now" is a small lie');
    assert.ok(/trader_signal/.test(out), 'depth comes from the tool, not the snapshot');
    assert.ok(/cannot place, size, or cancel/.test(out), 'the read-only boundary is stated');
  });

  await check('a failing endpoint degrades to silence, never an exception', async () => {
    setFixture(); FIXTURE = {};                       // every route errors
    assert.strictEqual(await tc.watchlistContext(uid()), '', 'a broken desk must not break the turn');
  });

  await check('an empty watchlist injects nothing rather than a bare heading', async () => {
    setFixture();
    FIXTURE['/api/trading/watchlist-prices'] = [];
    assert.strictEqual(await tc.watchlistContext(uid()), '');
  });

  await check('a huge watchlist is capped so it cannot crowd out the base prompt', async () => {
    setFixture();
    FIXTURE['/api/trading/watchlist-prices'] =
      Array.from({ length: 200 }, (_, i) => ({ ticker: 'T' + i, price: 10 + i, chg_pct: 0.1 }));
    const out = await tc.watchlistContext(uid());
    assert.ok(out.length < 6000, 'bounded (was ' + out.length + ' chars)');
    assert.ok(!out.includes('T199'), 'the tail is dropped rather than the prompt being swamped');
  });

  await check('the per-user cache is not shared between users', async () => {
    setFixture();
    const a = await tc.watchlistContext('cache-a');
    FIXTURE['/api/trading/watchlist-prices'] = [{ ticker: 'ZZZZ', price: 1, chg_pct: 0 }];
    const b = await tc.watchlistContext('cache-b');
    assert.ok(a.includes('SPY') && b.includes('ZZZZ') && !b.includes('SPY'),
      'one user\'s watchlist must never be served to another');
  });

  http.get = realGet;
  process.exit(failures ? 1 : 0);
})();
