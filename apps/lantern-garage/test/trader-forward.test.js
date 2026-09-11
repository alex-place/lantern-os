'use strict';
/**
 * test/trader-forward.test.js — #3523.
 *
 * With the app split, the web process forwards the few /api/trading routes whose state
 * lives in the trader process, and only those. The request must reach the trader as it
 * was sent (method, path, query, body, the session cookie, the proxy's x-forwarded-*
 * headers), and a trader that's down must answer 502 with a clear message, never hang.
 * Real HTTP servers on loopback; no network.
 * Run: node --test apps/lantern-garage/test/trader-forward.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const tf = require('../lib/trader-forward');

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const request = (port, method, path, headers = {}, body = '') => new Promise((resolve, reject) => {
  const r = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  r.on('error', reject);
  r.end(body);
});

test('exactly the trader-owned routes are forwarded', () => {
  for (const p of ['/api/trading/extended-hours', '/api/trading/overnight-scan', '/api/trading/kalshi/monitor/start',
    '/api/trading/kalshi/monitor/stop', '/api/trading/kalshi/monitor/positions', '/api/trading/brake/status',
    '/api/trading/sigma-trader', '/api/trading/champion']) {
    assert.strictEqual(tf.shouldForward(p), true, p);
  }
  for (const p of ['/api/trading/positions', '/api/trading/orders', '/api/trading/mode', '/api/trading/kalshi/monitor', '/api/broker/alpaca/status']) {
    assert.strictEqual(tf.shouldForward(p), false, p);
  }
  for (const [p, why] of tf.FORWARD) assert.ok(why.length > 10, `${p} says why it belongs to the trader`);
});

test('the request reaches the trader as sent: method, path, query, body, cookie, proxy headers', async () => {
  let seen = null;
  const trader = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, body, cookie: req.headers.cookie, xff: req.headers['x-forwarded-for'], by: req.headers['x-lantern-forwarded-by'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, from: 'trader' }));
    });
  });
  const web = await listen((req, res) => tf.forward(req, res, new URL(req.url, 'http://web'), { target: `http://127.0.0.1:${trader.address().port}` }));
  try {
    const r = await request(web.address().port, 'POST', '/api/trading/extended-hours?set=on',
      { cookie: 'connect.sid=s%3Aabc', 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, '{"a":1}');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { enabled: true, from: 'trader' });
    assert.deepStrictEqual(seen, { method: 'POST', url: '/api/trading/extended-hours?set=on', body: '{"a":1}',
      cookie: 'connect.sid=s%3Aabc', xff: '203.0.113.9', by: 'web' });
  } finally {
    web.close();
    trader.close();
  }
});

test("a trader that's down answers 502 with a clear message, not a hang", async () => {
  const web = await listen((req, res) => tf.forward(req, res, new URL(req.url, 'http://web'), { target: 'http://127.0.0.1:1', timeoutMs: 3000 }));
  try {
    const r = await request(web.address().port, 'GET', '/api/trading/brake/status');
    assert.strictEqual(r.status, 502);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.error, 'trader_unreachable');
    assert.match(j.message, /restarts on its own/);
  } finally {
    web.close();
  }
});
