'use strict';
/**
 * test/share-store.test.js — #3562.
 *
 * A share is a file on disk that anybody with the link can read, so the properties worth
 * pinning are the ones a reader is trusting: the id cannot be guessed or counted to, only
 * the owner can take it down, a revoke is a DELETE rather than a flag, and one reader
 * cannot fill the disk.
 *
 * Run: node --test apps/lantern-garage/test/share-store.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-'));
process.env.JOURNAL_SHARE_DIR = DIR;
const S = require('../lib/share-store');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

const payload = (over) => Object.assign({ v: 1, kind: 'month', label: 'Monthly report',
  dollars: false, card: { month: '2026-09' }, basis: 'booked ledger', sharedAt: '2026-09-13T00:00:00.000Z' }, over);

test('an id cannot be guessed, counted to, or misread', () => {
  const ids = new Set();
  for (let i = 0; i < 50000; i++) ids.add(S.newId());
  assert.strictEqual(ids.size, 50000, 'no collisions in fifty thousand');
  const one = S.newId();
  assert.strictEqual(one.length, S.ID_LEN);
  // No I, L, O or U: a share id gets read aloud and typed, and a link that fails because
  // a 1 was read as an l is a support ticket rather than a security property.
  assert.doesNotMatch(one, /[ilou]/);
  // Sequential creation must not produce sequential ids.
  const a = S.newId(), b = S.newId();
  assert.notStrictEqual(a.slice(0, 8), b.slice(0, 8));
});

test('every character of the alphabet is equally likely, at every position', () => {
  /* The first version took a random byte modulo 32, which is unbiased only because 256
     happens to be eight times 32 -- add one character to the alphabet and every id
     quietly skews toward its first few letters, with nothing to notice. CodeQL caught the
     pattern; this catches the behaviour, which is what would actually go wrong. */
  const counts = new Map();
  const N = 40000;
  for (let i = 0; i < N; i++) for (const ch of S.newId()) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.strictEqual(counts.size, 32, 'every character appears: ' + counts.size);
  const expected = (N * S.ID_LEN) / 32;
  for (const [ch, n] of counts) {
    const dev = Math.abs(n - expected) / expected;
    assert.ok(dev < 0.05, ch + ' appeared ' + n + ' times against ' + Math.round(expected)
      + ' expected (' + (dev * 100).toFixed(1) + '% off)');
  }
});

test('only our own ids can name a file', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '', 'SHOUTING0000000000000000000',
    'short', 'l'.repeat(S.ID_LEN), 'i'.repeat(S.ID_LEN), null, undefined, 42]) {
    assert.strictEqual(S.validId(bad), false, JSON.stringify(bad) + ' must not validate');
    assert.strictEqual(S.get(bad), null, JSON.stringify(bad) + ' must not resolve');
  }
  assert.strictEqual(path.dirname(path.resolve(S.fileFor(S.newId()))), path.resolve(DIR));
});

test('a share is readable by id and belongs to its owner', () => {
  const rec = S.create('reader-a', payload());
  assert.strictEqual(S.get(rec.id).payload.card.month, '2026-09');
  assert.strictEqual(S.get(rec.id).owner, 'reader-a');
  assert.deepStrictEqual(S.listFor('reader-a').map((x) => x.id), [rec.id]);
  assert.deepStrictEqual(S.listFor('reader-b'), [], 'and to nobody else');
  S.revoke('reader-a', rec.id);
});

test('a listing names a share without re-publishing it', () => {
  // What a reader needs to recognise and revoke one, and not the figures again.
  const rec = S.create('reader-a', payload({ dollars: true, card: { month: '2026-08', pnl: 1234.5 } }));
  const [row] = S.listFor('reader-a');
  assert.deepStrictEqual(Object.keys(row).sort(), ['createdAt', 'dollars', 'id', 'kind', 'label', 'month']);
  assert.ok(!JSON.stringify(row).includes('1234.5'), 'the listing does not carry the money again');
  S.revoke('reader-a', rec.id);
});

test('only the owner can take a share down, and a stranger is told nothing', () => {
  const rec = S.create('reader-a', payload());
  assert.strictEqual(S.revoke('reader-b', rec.id), false);
  assert.strictEqual(S.revoke(null, rec.id), false);
  assert.strictEqual(S.revoke('', rec.id), false);
  assert.ok(S.get(rec.id), 'and it is still there afterwards');
  assert.strictEqual(S.revoke('reader-a', rec.id), true);
});

test('a revoke is a delete — nothing is left on disk to leak later', () => {
  const rec = S.create('reader-a', payload({ card: { month: '2026-09', pnl: 99999 } }));
  const file = S.fileFor(rec.id);
  assert.ok(fs.existsSync(file));
  S.revoke('reader-a', rec.id);
  assert.strictEqual(fs.existsSync(file), false, 'the file is gone, not flagged');
  assert.strictEqual(S.get(rec.id), null);
  // A revoked share and one that never existed are the same answer.
  assert.strictEqual(S.get(S.newId()), null);
  assert.deepStrictEqual(S.listFor('reader-a'), []);
});

test('revoking twice reports the second one honestly', () => {
  const rec = S.create('reader-a', payload());
  assert.strictEqual(S.revoke('reader-a', rec.id), true);
  assert.strictEqual(S.revoke('reader-a', rec.id), false, 'there is nothing left to revoke');
});

test('one reader cannot fill the disk', () => {
  const made = [];
  for (let i = 0; i < S.MAX_PER_OWNER; i++) made.push(S.create('greedy', payload()));
  assert.throws(() => S.create('greedy', payload()), (e) => e.code === 'share_limit');
  // And the cap is per reader, not global.
  const other = S.create('modest', payload());
  assert.ok(other.id);
  for (const m of made) S.revoke('greedy', m.id);
  S.revoke('modest', other.id);
  // Revoking makes room again — the cap is on what is live, not on what was ever made.
  assert.ok(S.create('greedy', payload()).id);
  S.listFor('greedy').forEach((r) => S.revoke('greedy', r.id));
});

test('a torn or hand-edited file is skipped rather than fatal', () => {
  fs.writeFileSync(path.join(DIR, S.newId() + '.json'), '{"id":"nope",');
  fs.writeFileSync(path.join(DIR, 'not-a-share.txt'), 'hello');
  const rec = S.create('reader-a', payload());
  assert.deepStrictEqual(S.listFor('reader-a').map((x) => x.id), [rec.id]);
  S.revoke('reader-a', rec.id);
});
