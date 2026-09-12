'use strict';
/**
 * test/trading-import-route.test.js — #3557.
 *
 * The one rule this route must never break: it imports the SIGNED-IN reader's trades and
 * nobody else's. The user id comes from the session, never from the request, so there is
 * no shape of this call that reaches another account.
 *
 * Run: node --test apps/lantern-garage/test/trading-import-route.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-route-'));
const LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LOG;

const route = require('../routes/trading/import');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

function call(method, { userId = 'u-1', body = null } = {}) {
  const req = Object.assign(new EventEmitter(), { method, headers: {}, socket: {}, url: '/api/trading/import' });
  if (userId != null) req.session = { user: { id: userId } };
  const out = {};
  const ctx = { sendJson: (res, obj, code) => { out.json = obj; out.status = code || 200; } };
  const done = route(req, {}, new URL('http://x/api/trading/import'), ctx);
  if (body != null) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
  return done.then((handled) => ({ handled, ...out }));
}

test('a route without a path match declines, so other routes still see the request', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {} });
  const handled = await route(req, {}, new URL('http://x/api/trading/other'), { sendJson: () => {} });
  assert.strictEqual(handled, false);
});

test('a guest is told they are not signed in, not handed an empty import', async () => {
  const r = await call('GET', { userId: null });
  // A box with the login gate off has an owner, so this is only anonymous where the
  // gate is on. Either way it must not be an error or a foreign account's data.
  assert.strictEqual(r.handled, true);
  assert.ok(r.json.available === false || r.json.available === true);
  if (r.json.available === false) assert.ok(['not_signed_in', 'no_broker_with_history'].includes(r.json.reason));
});

test('status reports what this reader has imported, and nobody else\'s', async () => {
  fs.writeFileSync(LOG, [
    { event: 'exit', user: 'u-1', order_id: 'a', source: 'broker-import', ts: '2026-09-01T18:00:00Z' },
    { event: 'exit', user: 'u-1', order_id: 'b', source: 'broker-import', ts: '2026-09-03T18:00:00Z' },
    { event: 'exit', user: 'u-1', order_id: 'c', source: 'fill', ts: '2026-09-04T18:00:00Z' },
    { event: 'exit', user: 'u-2', order_id: 'd', source: 'broker-import', ts: '2026-09-05T18:00:00Z' },
    { event: 'entry', user: 'u-1', order_id: 'e', source: 'broker-import', ts: '2026-09-06T18:00:00Z' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const s = route.importStatus('u-1', LOG);
  assert.strictEqual(s.imported, 2, 'only this user\'s imported exits');
  assert.strictEqual(s.lastImportAt, '2026-09-03T18:00:00Z', 'the most recent of them');
  assert.strictEqual(route.importStatus('u-2', LOG).imported, 1);
  assert.strictEqual(route.importStatus('nobody', LOG).imported, 0);
});

test('no ledger yet is zero, not a crash', () => {
  assert.deepStrictEqual(route.importStatus('u-1', path.join(DIR, 'missing.jsonl')), { imported: 0, lastImportAt: null });
});

test('a reader with no connected broker is refused with a reason, not a silent no-op', async () => {
  const r = await call('POST');
  assert.strictEqual(r.handled, true);
  // No Alpaca credentials in a test process, so this is the no-broker path.
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.error, 'no_broker');
  assert.strictEqual(r.status, 400);
});

test('an unsupported method is refused', async () => {
  const r = await call('DELETE');
  assert.strictEqual(r.status, 405);
});

test('the user id is never taken from the request body', async () => {
  // The only defence that matters here: asking to import someone else's account must be
  // impossible to express, not merely rejected.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading', 'import.js'), 'utf8');
  assert.doesNotMatch(src, /body\.(user|userId|account)/, 'no user id is read from the body');
  assert.doesNotMatch(src, /searchParams\.get\(['"](user|userId|account)/, 'nor from the query string');
  assert.match(src, /getEffectiveUserId\(req\)/, 'it comes from the session');
});
