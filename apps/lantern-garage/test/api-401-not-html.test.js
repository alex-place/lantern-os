'use strict';
// #2980 — an unauthenticated request to a JSON/XHR surface must get 401 JSON, not a 302 to the
// HTML login page (which fetch() follows transparently, yielding login HTML where JSON was
// expected and an endless auth.html re-download loop). Document navigations still 302.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-strong-secret-value-xxxx';
const auth = require(path.join(__dirname, '..', 'lib', 'auth-middleware'));

function mockRes() {
  const res = { statusCode: 0, headers: {}, body: '', ended: false };
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res; };
  res.end = (b) => { res.body = b || ''; res.ended = true; return res; };
  return res;
}
const req = (url, headers = {}) => ({ url, method: 'GET', headers, session: undefined, socket: { localPort: 4177, remoteAddress: '203.0.113.7' } });

test('API request (/api/*) → 401 JSON auth_required, never a 302', () => {
  const res = mockRes();
  assert.strictEqual(auth.requireAuth(req('/api/trading/portfolio'), res), false);
  assert.strictEqual(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error, 'auth_required');
  assert.strictEqual(body.returnTo, '/api/trading/portfolio');
  assert.ok(!res.headers.Location, 'must not redirect');
});

test('document navigation (page URL) → still 302 to /auth.html', () => {
  const res = mockRes();
  assert.strictEqual(auth.requireAuth(req('/kalshi-terminal.html'), res), false);
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.Location, '/auth.html');
});

test('non-navigate Sec-Fetch-Mode (fetch/XHR) on a non-/api path → 401', () => {
  const res = mockRes();
  assert.strictEqual(auth.requireAuth(req('/some/data', { 'sec-fetch-mode': 'cors' }), res), false);
  assert.strictEqual(res.statusCode, 401);
});

test('Accept: application/json (not html) → 401', () => {
  const res = mockRes();
  auth.requireAuth(req('/x', { accept: 'application/json' }), res);
  assert.strictEqual(res.statusCode, 401);
});

test('requireEntitlement on /api/* → 401 JSON, not 302', () => {
  const res = mockRes();
  assert.strictEqual(auth.requireEntitlement(req('/api/trading/orders'), res, 'trade'), false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).error, 'auth_required');
});

test('requireStaff on /api/* → 401 JSON, not 302', () => {
  const res = mockRes();
  assert.strictEqual(auth.requireStaff(req('/api/accounts/list'), res), false);
  assert.strictEqual(res.statusCode, 401);
});
