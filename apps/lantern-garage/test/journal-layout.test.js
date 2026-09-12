'use strict';
/**
 * test/journal-layout.test.js — #3543.
 *
 * The journal's arrangement belongs to the reader: which cards show, in what order, at
 * what width. It is stored per user so it follows them to another device, and a guest is
 * never an error — their arrangement simply stays in their browser.
 *
 * A stored file is input like any other, so it is validated on the way out as well as in.
 * Run: node --test apps/lantern-garage/test/journal-layout.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-layout-'));
process.env.JOURNAL_LAYOUT_DIR = DIR;
const store = require('../lib/journal-layout');
const route = require('../routes/journal-layout');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

const LAYOUT = { v: 2, order: ['kpis', 'calendar', 'balance'], hidden: ['balance'],
  span: { calendar: 12, kpis: 4 }, h: { calendar: 320 } };

test('a good layout survives the round trip', () => {
  assert.deepStrictEqual(store.set('u-1', LAYOUT), LAYOUT);
  assert.deepStrictEqual(store.get('u-1'), LAYOUT);
});

test('normalize keeps what it understands and drops the rest', () => {
  const dirty = {
    order: ['kpis', 'kpis', 'calendar', 'Bad Id', '', 42, 'placements'],
    hidden: ['placements', 'placements', 'never-added'],
    span: { calendar: 8, kpis: 99, ghost: 6, placements: 1 },
    h: { calendar: 300, kpis: 5, placements: 99999 },
    somethingElse: 'ignored',
  };
  assert.deepStrictEqual(store.normalize(dirty), {
    v: 2,
    order: ['kpis', 'calendar', 'placements'],   // duplicates and junk ids gone, order kept
    hidden: ['placements'],                       // hiding a card that isn't in the order is meaningless
    span: { calendar: 8 },                        // 3..12, and only for cards in the order
    h: { calendar: 300 },                         // a height a scroll box could actually be
  });
});

test('a layout stored before spans existed is READ, not discarded (#3565)', () => {
  // v1 offered half or full. Someone arranged their journal with it; changing our schema
  // is not a reason to hand them back the default.
  const v1 = { v: 1, order: ['kpis', 'calendar', 'balance'], hidden: ['balance'], width: { kpis: 2, calendar: 1 } };
  assert.deepStrictEqual(store.normalize(v1), {
    v: 2,
    order: ['kpis', 'calendar', 'balance'],
    hidden: ['balance'],
    span: { kpis: 12, calendar: 6 },              // full became twelve twelfths, half became six
    h: {},
  });
});

test('where both shapes are present, the newer one wins', () => {
  const mixed = { order: ['kpis'], span: { kpis: 5 }, width: { kpis: 2 } };
  assert.strictEqual(store.normalize(mixed).span.kpis, 5);
});

test('a span below a quarter of the page is refused, not clamped silently', () => {
  // Clamping would store something the reader never chose; dropping it leaves the card
  // at its own default, which is a shape that is known to work.
  assert.deepStrictEqual(store.normalize({ order: ['kpis'], span: { kpis: 2 } }).span, {});
  assert.deepStrictEqual(store.normalize({ order: ['kpis'], span: { kpis: 3 } }).span, { kpis: 3 });
  assert.deepStrictEqual(store.normalize({ order: ['kpis'], span: { kpis: 6.5 } }).span, {}, 'and half a column is not a column');
});

test('a layout with nothing in it, or absurdly many cards, is refused', () => {
  for (const bad of [null, undefined, 'nope', [], {}, { order: [] }, { order: ['!'] },
    { order: Array.from({ length: store.MAX_CARDS + 1 }, (_, i) => 'c' + i) }]) {
    assert.strictEqual(store.normalize(bad), null, JSON.stringify(bad));
  }
});

test('a corrupt file reads as no layout, not as a crash', () => {
  fs.writeFileSync(path.join(DIR, 'u-2.json'), '{ this is not json');
  assert.strictEqual(store.get('u-2'), null);
  fs.writeFileSync(path.join(DIR, 'u-3.json'), JSON.stringify({ order: [] }));
  assert.strictEqual(store.get('u-3'), null);
});

test('a guest has no stored layout, and storing one is refused quietly', () => {
  assert.strictEqual(store.get(null), null);
  assert.strictEqual(store.set(null, LAYOUT), null);
  assert.strictEqual(store.clear(null), false);
});

test('clear forgets it', () => {
  store.set('u-4', LAYOUT);
  assert.ok(store.get('u-4'));
  assert.strictEqual(store.clear('u-4'), true);
  assert.strictEqual(store.get('u-4'), null);
  assert.strictEqual(store.clear('u-4'), false, 'nothing left to remove');
});

// ── the route ───────────────────────────────────────────────────────────────────
async function call(method, body, { userId = 'u-route' } = {}) {
  const req = Object.assign(new EventEmitter(), { method, headers: {}, socket: {}, url: '/api/journal/layout' });
  if (userId != null) req.session = { user: { id: userId } };   // no session at all = an anonymous request
  const out = {};
  const res = {
    writeHead: (code, h) => { out.status = code; out.headers = h; },
    end: (b) => { out.body = b; },
  };
  const done = route(req, res, new URL('http://x/api/journal/layout'));
  if (method !== 'GET' && method !== 'DELETE') {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  }
  const handled = await done;
  let json = null;
  try { json = JSON.parse(out.body); } catch (_e) { /* not json */ }
  return { handled, status: out.status, json };
}

test('the route stores, returns and forgets a layout for a signed-in reader', async () => {
  const empty = await call('GET');
  assert.deepStrictEqual([empty.handled, empty.status, empty.json.layout], [true, 200, null]);

  const saved = await call('POST', { layout: LAYOUT });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual([saved.json.ok, saved.json.stored], [true, true]);
  assert.deepStrictEqual(saved.json.layout, LAYOUT);

  const read = await call('GET');
  assert.deepStrictEqual(read.json, { layout: LAYOUT, stored: true });

  const gone = await call('DELETE');
  assert.deepStrictEqual([gone.json.ok, gone.json.removed], [true, true]);
  assert.strictEqual((await call('GET')).json.layout, null);
});

test('the route refuses a layout it cannot store, and says why', async () => {
  const bad = await call('POST', { layout: { order: [] } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.error, 'bad_layout');
  const broken = await call('POST', 'not-json-at-all');
  assert.ok(broken.status === 400 || broken.status === 200, 'a malformed body never 500s');
});

test('a box with the login gate off stores the owner\'s arrangement; the hosted app does not store a stranger\'s', async () => {
  const amPath = require.resolve('../lib/auth-middleware');
  const real = require.cache[amPath];
  let gateOn = true;
  require.cache[amPath] = { id: amPath, filename: amPath, loaded: true, exports: { loginGateEnabled: () => gateOn } };
  try {
    const anon = { userId: null };
    gateOn = true;
    const hosted = await call('POST', { layout: LAYOUT }, anon);
    assert.strictEqual(hosted.json.stored, false, 'an anonymous visitor keeps it in their browser');
    assert.strictEqual(store.get('local-owner'), null);

    gateOn = false;
    const local = await call('POST', { layout: LAYOUT }, anon);
    assert.strictEqual(local.json.stored, true, 'on a single-user box the owner is the reader');
    assert.deepStrictEqual(store.get('local-owner'), LAYOUT);
  } finally {
    if (real) require.cache[amPath] = real; else delete require.cache[amPath];
    store.clear('local-owner');
  }
});

test('a route without a path match declines, so other routes still see the request', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {}, url: '/api/other' });
  const handled = await route(req, {}, new URL('http://x/api/other'));
  assert.strictEqual(handled, false);
});
