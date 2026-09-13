'use strict';
/**
 * test/journal-share-route.test.js — #3562.
 *
 * The owner's half. Two properties carry the feature:
 *
 *   PREVIEW PUBLISHES NOTHING. A reader has to be able to see the exact payload — same
 *   function, same figures — before any of it is on the internet. A preview that went
 *   through the publish path and deleted afterwards would have a window where it was live.
 *
 *   THE SERVER COMPUTES THE CARD. The client names a kind; it never posts figures. A page
 *   carrying our name must carry the reader's record rather than what a browser claimed.
 *
 * Run: node --test apps/lantern-garage/test/journal-share-route.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'share-route-'));
const LEDGER = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LEDGER;
process.env.JOURNAL_SHARE_DIR = path.join(DIR, 'shares');

const route = require('../routes/journal-share');
const store = require('../lib/share-store');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

/* A small real book for one reader, spanning two ET months so the month card has a
   choice to get wrong. */
function seed() {
  const rows = [];
  const day = (d, n, pnl) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        ts: new Date(Date.UTC(2026, d[0], d[1], 18, i, 0)).toISOString(),
        user: 'u1', event: 'exit', symbol: ['SPY', 'QQQ'][i % 2], qty: 10,
        entry: 100 + i, exit: 100 + i + pnl / 10, pnl, pnl_pct: pnl / 10,
        reason: 'signal_exit', status: 'filled', order_id: `o-${d[0]}-${d[1]}-${i}`,
        stop_dist_pct: 3,
      });
    }
  };
  day([7, 25], 4, -50);          // August
  day([7, 26], 2, 30);
  day([8, 2], 3, 120);           // September
  day([8, 3], 3, -20);
  day([8, 4], 2, 80);
  fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
seed();

function call(pathname, { method = 'GET', user = 'u1', role = 'supporter', body = null } = {}) {
  const url = new URL('http://x' + pathname);
  const req = Object.assign(new EventEmitter(), {
    method, headers: { 'content-type': 'application/json' }, socket: {}, url: pathname,
  });
  if (user) req.session = { user: { id: user, role } };
  const out = { headers: {} };
  const res = {
    writeHead: (c, h) => { out.status = c; Object.assign(out.headers, h || {}); return res; },
    end: (b) => { out.raw = b; try { out.json = JSON.parse(b); } catch (_e) { /* not json */ } },
  };
  const p = Promise.resolve(route(req, res, url)).then((handled) => Object.assign({ handled }, out));
  if (body !== null) {
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  } else {
    setImmediate(() => req.emit('end'));
  }
  return p;
}

const mine = () => call('/api/journal/shares').then((r) => r.json.shares);

test('a path that is not ours declines', async () => {
  for (const p of ['/api/journal/coach', '/api/shared/x', '/journal.html']) {
    assert.strictEqual((await call(p)).handled, false, p);
  }
});

test('options offer only the cards this record can actually support', async () => {
  const r = await call('/api/journal/share/options');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.months, ['2026-09', '2026-08'], 'newest first');
  assert.deepStrictEqual(r.json.kinds.sort(), ['month', 'rmultiples', 'symbols']);
  assert.deepStrictEqual(r.json.moneyless, ['rmultiples']);
});

test('a preview publishes NOTHING', async () => {
  const before = (await mine()).length;
  const r = await call('/api/journal/share/preview?kind=month&month=2026-09');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.published, false);
  assert.ok(r.json.payload.card.month === '2026-09');
  assert.strictEqual((await mine()).length, before, 'nothing was created');
});

test('a preview is the SAME payload publishing would produce', async () => {
  // Otherwise "see exactly what will be public before it is" is not a promise.
  const prev = (await call('/api/journal/share/preview?kind=month&month=2026-09&dollars=1')).json.payload;
  const made = (await call('/api/journal/share', { method: 'POST', body: { kind: 'month', month: '2026-09', dollars: true } })).json;
  const strip = (p) => Object.assign({}, p, { sharedAt: null });
  assert.deepStrictEqual(strip(made.payload), strip(prev));
  await call('/api/journal/share?id=' + made.id, { method: 'DELETE' });
});

test('publishing returns the link, and the link is where the card lives', async () => {
  const r = await call('/api/journal/share', { method: 'POST', body: { kind: 'rmultiples' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.url, '/s/' + r.json.id);
  assert.ok(store.get(r.json.id), 'and it is on disk');
  await call('/api/journal/share?id=' + r.json.id, { method: 'DELETE' });
});

test('the client cannot post figures — the server computes the card', async () => {
  /* The page carries our name, so a shared card must be the reader's record rather than
     whatever a browser claimed. Anything in the body that is not a kind or an option is
     simply not read. */
  const r = await call('/api/journal/share', {
    method: 'POST',
    body: { kind: 'month', month: '2026-09', dollars: true, card: { pnl: 999999, month: '2026-09' }, payload: { evil: 1 } },
  });
  assert.strictEqual(r.status, 201);
  assert.notStrictEqual(r.json.payload.card.pnl, 999999);
  assert.ok(!JSON.stringify(r.json.payload).includes('evil'));
  await call('/api/journal/share?id=' + r.json.id, { method: 'DELETE' });
});

test('dollars are withheld unless this share asked for them', async () => {
  const off = (await call('/api/journal/share/preview?kind=month&month=2026-09')).json.payload;
  const on = (await call('/api/journal/share/preview?kind=month&month=2026-09&dollars=1')).json.payload;
  assert.ok(!('pnl' in off.card));
  assert.ok('pnl' in on.card);
  assert.strictEqual(off.dollars, false);
});

test('a month with nothing in it is refused rather than published empty', async () => {
  const r = await call('/api/journal/share', { method: 'POST', body: { kind: 'month', month: '2025-01' } });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.error, 'nothing_to_share');
});

test('a kind that is not shareable is refused', async () => {
  for (const kind of ['trades', 'notes', 'calendar', '']) {
    const r = await call('/api/journal/share', { method: 'POST', body: { kind } });
    assert.strictEqual(r.status, 422, kind);
  }
});

test('a reader sees only their own shares', async () => {
  const a = (await call('/api/journal/share', { method: 'POST', user: 'u1', body: { kind: 'rmultiples' } })).json;
  const theirs = (await call('/api/journal/shares', { user: 'someone-else' })).json.shares;
  assert.deepStrictEqual(theirs, []);
  assert.deepStrictEqual((await mine()).map((s) => s.id), [a.id]);
  await call('/api/journal/share?id=' + a.id, { method: 'DELETE' });
});

test('another reader cannot take down a share that is not theirs, and is told nothing', async () => {
  const a = (await call('/api/journal/share', { method: 'POST', user: 'u1', body: { kind: 'rmultiples' } })).json;
  const attempt = await call('/api/journal/share?id=' + a.id, { method: 'DELETE', user: 'someone-else' });
  // The same answer a made-up id gets: a 403 would confirm that this one exists.
  assert.strictEqual(attempt.status, 404);
  assert.strictEqual(attempt.json.error, 'no_such_share');
  assert.ok(store.get(a.id), 'and it is still live');
  const own = await call('/api/journal/share?id=' + a.id, { method: 'DELETE', user: 'u1' });
  assert.strictEqual(own.status, 200);
  assert.strictEqual(store.get(a.id), null);
});

test('revoking reports the truth the second time', async () => {
  const a = (await call('/api/journal/share', { method: 'POST', body: { kind: 'rmultiples' } })).json;
  assert.strictEqual((await call('/api/journal/share?id=' + a.id, { method: 'DELETE' })).status, 200);
  // The route called revoke twice once, which made every successful take-down report 404.
  assert.strictEqual((await call('/api/journal/share?id=' + a.id, { method: 'DELETE' })).status, 404);
});

test('with a login gate up, a sessionless caller cannot publish anything', async () => {
  /* The gate is toggled here rather than inherited from whatever this machine's flag
     store happens to say. Left ambient, this test passed in CI (no flag file, gate on)
     and failed on a box where the gate had been turned off for a preview -- and an
     assertion that depends on a gitignored file is not an assertion. */
  const auth = require('../lib/auth-middleware');
  const real = auth.loginGateEnabled;
  try {
    auth.loginGateEnabled = () => true;
    const r = await call('/api/journal/share', { method: 'POST', user: null, body: { kind: 'rmultiples' } });
    assert.strictEqual(r.status, 401);
  } finally { auth.loginGateEnabled = real; }
});

test('with no login gate, a local install is the owner -- the same convention as the rest of the journal', async () => {
  // A single-user local install has no session and is not a stranger. `local-owner` is
  // what the scorecard, the trade log and the coach all resolve to in that case.
  const auth = require('../lib/auth-middleware');
  const real = auth.loginGateEnabled;
  try {
    auth.loginGateEnabled = () => false;
    const r = await call('/api/journal/share/options', { user: null });
    assert.strictEqual(r.status, 200, 'served, not refused');
  } finally { auth.loginGateEnabled = real; }
});

test('one reader cannot fill the disk', async () => {
  const made = [];
  for (let i = 0; i < store.MAX_PER_OWNER; i++) {
    made.push((await call('/api/journal/share', { method: 'POST', body: { kind: 'rmultiples' } })).json.id);
  }
  const over = await call('/api/journal/share', { method: 'POST', body: { kind: 'rmultiples' } });
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.json.error, 'share_limit');
  for (const id of made) await call('/api/journal/share?id=' + id, { method: 'DELETE' });
});

test('nothing this route answers is cached', async () => {
  // A listing or a preview sitting in a cache after a revoke is the one way this feature
  // can keep serving something a reader took down.
  for (const p of ['/api/journal/shares', '/api/journal/share/options']) {
    assert.match((await call(p)).headers['Cache-Control'] || '', /no-store/, p);
  }
});
