'use strict';
/**
 * test/shared-route.test.js — #3562.
 *
 * /s/<id> and /api/shared/<id> are the ONLY surface in this journal that answers a
 * request with no session behind it, so the tests here are about what it refuses to say
 * as much as what it serves: no owner, no listing, no index, no different answer for a
 * revoked share than for one that never existed, and nothing for a search engine.
 *
 * The owner half (publish, preview, revoke) is in journal-share-route.test.js.
 *
 * Run: node --test apps/lantern-garage/test/shared-route.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-route-'));
process.env.JOURNAL_SHARE_DIR = DIR;
const route = require('../routes/shared');
const store = require('../lib/share-store');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

const PAYLOAD = {
  v: 1, kind: 'month', label: 'Monthly report', dollars: true,
  card: { month: '2026-09', tradingDays: 4, dayWinRate: 66.7, profitFactor: 2.1, pnl: 340.25 },
  basis: 'booked ledger, exchange days', sharedAt: '2026-09-13T00:00:00.000Z',
};

/* Deliberately sessionless: no cookie, no header, nothing. This is the public's request. */
function call(pathname, method = 'GET') {
  const url = new URL('http://x' + pathname);
  const req = { method, headers: {}, socket: {}, url: pathname };
  const out = { headers: {} };
  const res = {
    writeHead: (code, h) => { out.status = code; Object.assign(out.headers, h || {}); return res; },
    end: (b) => { out.raw = b; try { out.json = JSON.parse(b); } catch (_e) { /* html */ } },
  };
  return Promise.resolve(route(req, res, url)).then((handled) => Object.assign({ handled }, out));
}

test('a path that is not a share declines, so other routes still see the request', async () => {
  for (const p of ['/journal.html', '/api/journal/share', '/s', '/api/shared', '/']) {
    assert.strictEqual(await call(p).then((r) => r.handled), false, p);
  }
});

test('an anonymous reader gets the card — that is what sharing is', async () => {
  const rec = store.create('owner-1', PAYLOAD);
  const r = await call('/api/shared/' + rec.id);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.card.pnl, 340.25);
  store.revoke('owner-1', rec.id);
});

test('and gets NOTHING about who shared it', async () => {
  /* The stored record holds an owner and a created-at. The response is `payload`, which
     is a different object — the one thing standing between a share and a way to walk
     back to the person who made it. */
  const rec = store.create('owner-1', PAYLOAD);
  const r = await call('/api/shared/' + rec.id);
  assert.deepStrictEqual(Object.keys(r.json).sort(), ['basis', 'card', 'dollars', 'kind', 'label', 'sharedAt', 'v']);
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes('owner-1'), 'the owner travelled with it');
  assert.ok(!text.includes(rec.id), 'so did the id it is filed under');
  assert.ok(!text.includes('createdAt'));
  store.revoke('owner-1', rec.id);
});

test('a revoked share, a made-up id and a probe are the same 404', async () => {
  // Three different answers would tell an attacker which of the three they had found.
  const rec = store.create('owner-1', PAYLOAD);
  store.revoke('owner-1', rec.id);
  const codes = [];
  for (const id of [rec.id, store.newId(), 'zzz', '../../etc/passwd', 'a'.repeat(200)]) {
    codes.push((await call('/api/shared/' + encodeURIComponent(id))).status);
  }
  assert.deepStrictEqual(codes, [404, 404, 404, 404, 404]);
});

test('a share id is case-sensitive, so a near miss is still a miss', async () => {
  const rec = store.create('owner-1', PAYLOAD);
  assert.strictEqual((await call('/api/shared/' + rec.id.toUpperCase())).status, 404);
  store.revoke('owner-1', rec.id);
});

test('nothing here is offered to a search engine', async () => {
  /* "Nothing about a reader is reachable without them having shared it" does not survive
     being crawled: a link meant for five people becomes a result for everyone. Set on the
     page AND the API, in the header AND the markup, because a crawler that ignores one
     may honour the other. */
  const rec = store.create('owner-1', PAYLOAD);
  for (const p of ['/api/shared/' + rec.id, '/s/' + rec.id]) {
    const r = await call(p);
    assert.match(r.headers['X-Robots-Tag'] || '', /noindex/, p);
    assert.match(r.headers['Cache-Control'] || '', /no-store/, p + ' must not be cached past a revoke');
  }
  const page = await call('/s/' + rec.id);
  assert.match(page.raw, /<meta name="robots" content="noindex/);
  store.revoke('owner-1', rec.id);
});

test('the page carries no figures of its own', async () => {
  /* It fetches them, so a share revoked a second ago says so rather than serving a card
     baked into the HTML that is already on its way to the reader. */
  const rec = store.create('owner-1', PAYLOAD);
  const page = await call('/s/' + rec.id);
  assert.strictEqual(page.status, 200);
  assert.ok(!page.raw.includes('340.25'), 'the page was served with the money in it');
  assert.ok(!page.raw.includes(rec.id), 'or with the id in it');
  assert.match(page.raw, /fetch\('\/api\/shared\/'/, 'it asks for the payload');
  store.revoke('owner-1', rec.id);
});

test('a 404 page says what happened without blaming the reader', async () => {
  const r = await call('/s/' + store.newId());
  // The page is static, so a missing share is reported by the page itself after it asks.
  assert.strictEqual(r.status, 200);
  assert.match(r.raw, /not live/);
});

test('this surface only reads', async () => {
  const rec = store.create('owner-1', PAYLOAD);
  for (const m of ['POST', 'DELETE', 'PUT', 'PATCH']) {
    const r = await call('/api/shared/' + rec.id, m);
    assert.strictEqual(r.status, 405, m);
  }
  assert.ok(store.get(rec.id), 'and nothing was changed by trying');
  store.revoke('owner-1', rec.id);
});

test('HEAD is allowed, because a link preview is a reader following a link', async () => {
  const rec = store.create('owner-1', PAYLOAD);
  assert.strictEqual((await call('/api/shared/' + rec.id, 'HEAD')).status, 200);
  store.revoke('owner-1', rec.id);
});
