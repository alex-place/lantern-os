'use strict';
/**
 * test/notes-route.test.js — #3559.
 *
 * Notes are the reader's private writing about their own money, so the rule that matters
 * most here is the one about reach: the user id comes from the session and never from the
 * request, and there is no shape of this call that returns more than one reader's notes.
 *
 * Run: node --test apps/lantern-garage/test/notes-route.test.js
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-route-'));
process.env.TRADE_NOTES_DIR = DIR;
const LEDGER = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LEDGER;

const route = require('../routes/journal-notes');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });
beforeEach(() => { for (const f of fs.readdirSync(DIR)) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_e) { /* busy */ } } });

function call(method, { qs = '', body = null, userId = 'u-1' } = {}) {
  const url = new URL('http://x/api/journal/notes' + qs);
  const req = Object.assign(new EventEmitter(), { method, headers: {}, socket: {}, url: url.pathname + url.search });
  if (userId != null) req.session = { user: { id: userId } };
  const out = { headers: null };
  const res = {
    writeHead: (code, h) => { out.status = code; out.headers = h; return res; },
    end: (b) => { out.raw = b; try { out.json = JSON.parse(b); } catch (_e) { /* the export is a download */ } },
  };
  const done = route(req, res, url);
  if (body !== null) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
  return done.then((handled) => ({ handled, ...out }));
}

test('a non-matching path declines, so other routes still see the request', async () => {
  const other = new URL('http://x/api/journal/layout');
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {} });
  assert.strictEqual(await route(req, {}, other), false);
});

test('writing and reading back one trade\'s note', async () => {
  const saved = await call('POST', { body: { id: 'o1', note: 'chased it', tags: ['Chased'], feel: 'anxious' } });
  assert.strictEqual(saved.json.ok, true);
  assert.strictEqual(saved.json.saved.note, 'chased it');
  assert.deepStrictEqual(saved.json.saved.tags, ['chased'], 'normalised on the way in');
  assert.deepStrictEqual(saved.json.tags, [{ tag: 'chased', n: 1 }], 'and the known-tag list comes back with it');

  const read = await call('GET');
  assert.strictEqual(read.json.notes.o1.note, 'chased it');
  assert.strictEqual(read.json.stored, true);
});

test('emptying a note removes it, and still reports success', async () => {
  await call('POST', { body: { id: 'o1', note: 'x', tags: ['t'] } });
  const cleared = await call('POST', { body: { id: 'o1', note: '', tags: [], feel: null } });
  assert.strictEqual(cleared.json.ok, true, 'clearing is a success, not a refusal');
  assert.strictEqual(cleared.json.saved, null);
  assert.deepStrictEqual((await call('GET')).json.notes, {});
});

test('DELETE removes one note', async () => {
  await call('POST', { body: { id: 'o1', note: 'x' } });
  const gone = await call('DELETE', { qs: '?id=o1' });
  assert.deepStrictEqual([gone.json.ok, gone.json.removed], [true, true]);
  assert.deepStrictEqual((await call('GET')).json.notes, {});
  assert.strictEqual((await call('DELETE')).json.error, 'bad_request', 'with no id there is nothing to remove');
});

test('a malformed body is refused rather than stored', async () => {
  const bad = await call('POST', { body: { note: 'no id here' } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.error, 'bad_request');
});

test('one reader can never read or write another\'s', async () => {
  await call('POST', { body: { id: 'o1', note: 'mine' }, userId: 'u-1' });
  await call('POST', { body: { id: 'o1', note: 'theirs' }, userId: 'u-2' });
  assert.strictEqual((await call('GET', { userId: 'u-1' })).json.notes.o1.note, 'mine');
  assert.strictEqual((await call('GET', { userId: 'u-2' })).json.notes.o1.note, 'theirs');

  // The only defence that counts: asking for someone else's must be inexpressible.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'journal-notes.js'), 'utf8');
  assert.doesNotMatch(src, /searchParams\.get\(['"](user|userId|account)/, 'no reader id from the query');
  assert.doesNotMatch(src, /body\.(user|userId|account)/, 'nor from the body');
  assert.match(src, /getEffectiveUserId\(req\)/, 'it comes from the session');
});

test('a guest gets an empty set and a 401 on writing, not a crash either way', async () => {
  const read = await call('GET', { userId: null });
  assert.strictEqual(read.status, 200);
  assert.deepStrictEqual(read.json.notes, {});
  // With the login gate off this box has an owner, so a write may legitimately succeed.
  const write = await call('POST', { body: { id: 'o1', note: 'x' }, userId: null });
  assert.ok(write.status === 401 || write.status === 200);
});

test('the stats view prices the reader\'s tags against their own trades', async () => {
  fs.writeFileSync(LEDGER, [
    { ts: '2026-09-01T18:00:00Z', user: 'u-1', event: 'exit', symbol: 'SPY', qty: 10, entry: 100, exit: 110, pnl: 100, pnl_pct: 10, status: 'filled', order_id: 'a1' },
    { ts: '2026-09-02T18:00:00Z', user: 'u-1', event: 'exit', symbol: 'QQQ', qty: 5, entry: 200, exit: 188, pnl: -60, pnl_pct: -6, status: 'filled', order_id: 'a2' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await call('POST', { body: { id: 'a1', tags: ['breakout'], feel: 'calm' } });
  await call('POST', { body: { id: 'a2', tags: ['chased'], feel: 'anxious' } });

  const s = await call('GET', { qs: '?stats=1' });
  assert.strictEqual(s.json.trades, 2);
  assert.strictEqual(s.json.annotated, 2);
  const byTag = Object.fromEntries(s.json.tags.map((t) => [t.key, t]));
  assert.strictEqual(byTag.breakout.totalRealized, 100);
  assert.strictEqual(byTag.chased.totalRealized, -60);
  assert.strictEqual(byTag.chased.winRate, 0);
});

test('the export is their own writing, in a form they can keep', async () => {
  await call('POST', { body: { id: 'o1', note: 'kept', tags: ['x'] } });
  const out = await call('GET', { qs: '?export=1' });
  assert.strictEqual(out.status, 200);
  assert.match(out.headers['Content-Disposition'], /attachment; filename="unisona-trade-notes\.json"/);
  const parsed = JSON.parse(out.raw);
  assert.strictEqual(parsed.notes.o1.note, 'kept');
  assert.ok(parsed.exportedAt, 'stamped, so a reader knows how old the copy is');
});

test('notes live under /api/journal, not behind the trading gate (#3559)', () => {
  // /api/trading/* requires the `trade` entitlement, which is Pro. A reader's own writing
  // about their own record should not inherit a gate meant for placing orders, and the
  // card arrangement next door already establishes where journal personalisation lives.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'journal-notes.js'), 'utf8');
  assert.match(src, /const PATH = '\/api\/journal\/notes'/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\("\.\/routes\/journal-notes"\)/, 'registered beside journal-layout');
  const trading = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading.js'), 'utf8');
  assert.doesNotMatch(trading, /journal-notes|trading\/notes/, 'and not inside the trading router');
});

test('an unsupported method is refused', async () => {
  assert.strictEqual((await call('PUT')).status, 405);
});
