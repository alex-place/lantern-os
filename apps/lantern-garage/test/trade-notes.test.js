'use strict';
/**
 * test/trade-notes.test.js — #3559.
 *
 * A reader's private writing about their own money, so the things worth pinning are the
 * ones that would lose it or leak it: an entry that normalizes to nothing must remove the
 * record rather than leave an empty one, tags must collapse to one spelling or the
 * aggregate is meaningless, and nothing here may read across users.
 *
 * Run: node --test apps/lantern-garage/test/trade-notes.test.js
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-notes-'));
process.env.TRADE_NOTES_DIR = DIR;
const store = require('../lib/trade-notes');
const { taggedStats } = require('../lib/trade-log');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });
beforeEach(() => { for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f)); });

test('a note, its tags and how it felt survive the round trip', () => {
  store.set('u-1', 'o1', { note: 'chased the open', tags: ['chased', 'breakout'], feel: 'anxious' });
  const got = store.get('u-1', 'o1');
  assert.strictEqual(got.note, 'chased the open');
  assert.deepStrictEqual(got.tags, ['chased', 'breakout']);
  assert.strictEqual(got.feel, 'anxious');
  assert.ok(got.at, 'and when it was written');
});

test('tags collapse to one spelling, because the aggregate is the whole point', () => {
  store.set('u-1', 'o1', { tags: ['Chased', 'CHASED', '  chased  ', 'news   gap', 'news gap'] });
  assert.deepStrictEqual(store.get('u-1', 'o1').tags, ['chased', 'news gap'],
    'case, padding and repeated spaces are the same tag');
});

test('emptying the boxes takes the note back, rather than leaving an empty record', () => {
  // There is no separate delete gesture to learn: clearing IS the deletion.
  store.set('u-1', 'o1', { note: 'something', tags: ['x'], feel: 'calm' });
  assert.ok(store.get('u-1', 'o1'));
  assert.strictEqual(store.set('u-1', 'o1', { note: '', tags: [], feel: null }), null);
  assert.strictEqual(store.get('u-1', 'o1'), null);
  assert.deepStrictEqual(store.all('u-1').notes, {}, 'nothing left behind');
});

test('a note is bounded, and junk in it is dropped rather than stored', () => {
  const long = 'x'.repeat(5000);
  assert.strictEqual(store.set('u-1', 'o1', { note: long }).note.length, store.MAX_NOTE);
  const many = Array.from({ length: 40 }, (_, i) => 'tag' + i);
  assert.strictEqual(store.set('u-1', 'o2', { tags: many }).tags.length, store.MAX_TAGS);
  assert.deepStrictEqual(store.set('u-1', 'o3', { tags: ['ok', '<script>', 'A'.repeat(80), '', 42, null] }).tags, ['ok'],
    'a tag that is not a tag is left out');
  assert.strictEqual(store.set('u-1', 'o4', { note: 'x', feel: 'ecstatic' }).feel, null,
    'a feeling outside the list is no feeling');
});

test('an id that is not a trade id is refused', () => {
  assert.strictEqual(store.set('u-1', '../../etc/passwd', { note: 'x' }), null);
  assert.strictEqual(store.set('u-1', '', { note: 'x' }), null);
  assert.strictEqual(store.set('u-1', 'x'.repeat(200), { note: 'x' }), null);
  // The trade log's fallback id is ts|symbol|qty, so that shape has to be allowed.
  assert.ok(store.set('u-1', '2026-09-01T18:00:00.000Z|SPY|10', { note: 'x' }));
});

test('one reader never sees another\'s', () => {
  store.set('u-1', 'o1', { note: 'mine' });
  store.set('u-2', 'o1', { note: 'theirs' });
  assert.strictEqual(store.get('u-1', 'o1').note, 'mine');
  assert.strictEqual(store.get('u-2', 'o1').note, 'theirs', 'the same trade id in two books is two notes');
  assert.strictEqual(Object.keys(store.all('u-1').notes).length, 1);
});

test('a guest writes nothing and reads nothing, quietly', () => {
  assert.strictEqual(store.set(null, 'o1', { note: 'x' }), null);
  assert.strictEqual(store.get(null, 'o1'), null);
  assert.deepStrictEqual(store.all(null).notes, {});
  assert.strictEqual(store.clear(null), false);
});

test('a corrupt file reads as no notes, not as a crash', () => {
  fs.writeFileSync(path.join(DIR, 'u-9.json'), '{ not json at all');
  assert.deepStrictEqual(store.all('u-9').notes, {});
  fs.writeFileSync(path.join(DIR, 'u-8.json'), JSON.stringify({ notes: 'nope' }));
  assert.deepStrictEqual(store.all('u-8').notes, {});
});

test('the tags a reader has used come back most-used first, so the next one is a pick', () => {
  store.set('u-1', 'o1', { tags: ['chased', 'breakout'] });
  store.set('u-1', 'o2', { tags: ['chased'] });
  store.set('u-1', 'o3', { tags: ['chased', 'breakout'] });
  store.set('u-1', 'o4', { tags: ['news'] });
  assert.deepStrictEqual(store.tagsUsed('u-1'), [
    { tag: 'chased', n: 3 }, { tag: 'breakout', n: 2 }, { tag: 'news', n: 1 },
  ]);
  assert.deepStrictEqual(store.tagsUsed('nobody'), []);
});

test('clear forgets everything they wrote', () => {
  store.set('u-1', 'o1', { note: 'x' });
  assert.strictEqual(store.clear('u-1'), true);
  assert.deepStrictEqual(store.all('u-1').notes, {});
  assert.strictEqual(store.clear('u-1'), false, 'nothing left to remove');
});

// ── the payoff ─────────────────────────────────────────────────────────────────
let n = 0;
const row = (o) => {
  n += 1;
  return Object.assign({
    ts: '2026-09-0' + (1 + (n % 9)) + 'T18:00:00.000Z', event: 'exit', symbol: 'SPY',
    qty: 10, entry: 100 + n * 0.001, exit: 105, pnl: 50, pnl_pct: 5,
    reason: 'signal_exit', status: 'filled', order_id: 'o' + n,
  }, o);
};

test('tags are priced with the same arithmetic as every other figure', () => {
  const rows = [row({ pnl: 100 }), row({ pnl: -60 }), row({ pnl: 20 })];
  const notes = {
    [rows[0].order_id]: { note: '', tags: ['breakout'], feel: 'calm' },
    [rows[1].order_id]: { note: '', tags: ['breakout', 'chased'], feel: 'anxious' },
    [rows[2].order_id]: { note: '', tags: ['chased'], feel: 'anxious' },
  };
  const s = taggedStats(rows, notes);
  assert.strictEqual(s.trades, 3);
  assert.strictEqual(s.annotated, 3);
  const byTag = Object.fromEntries(s.tags.map((t) => [t.key, t]));
  assert.strictEqual(byTag.breakout.trades, 2);
  assert.strictEqual(byTag.breakout.totalRealized, 40, '100 and -60');
  assert.strictEqual(byTag.chased.trades, 2);
  assert.strictEqual(byTag.chased.totalRealized, -40, '-60 and 20');
  assert.strictEqual(byTag.chased.expectancy, -20, 'which is the number worth having');
  const byFeel = Object.fromEntries(s.feelings.map((t) => [t.key, t]));
  assert.strictEqual(byFeel.anxious.trades, 2);
  assert.strictEqual(byFeel.calm.trades, 1);
});

test('the table says how much of the book has been written about', () => {
  // A tag table drawn from four of two hundred trades is a note to self, not a finding.
  const rows = Array.from({ length: 20 }, () => row({}));
  const notes = { [rows[0].order_id]: { tags: ['x'] }, [rows[1].order_id]: { tags: ['x'] } };
  const s = taggedStats(rows, notes);
  assert.deepStrictEqual([s.trades, s.annotated], [20, 2]);
});

test('an untagged book produces no tags, not an empty-looking finding', () => {
  const rows = [row({}), row({})];
  assert.deepStrictEqual(taggedStats(rows, {}).tags, []);
  assert.deepStrictEqual(taggedStats(rows, null).feelings, []);
  assert.deepStrictEqual(taggedStats([], {}), { trades: 0, annotated: 0, tags: [], feelings: [] });
});

test('a note on a trade that is not in the book counts for nothing', () => {
  const rows = [row({ pnl: 100 })];
  const s = taggedStats(rows, { 'some-other-trade': { tags: ['ghost'] } });
  assert.strictEqual(s.annotated, 0);
  assert.deepStrictEqual(s.tags, []);
});

test('tags are counted against booked trades, not decisions that never filled', () => {
  const filled = row({ pnl: 100, status: 'filled' });
  const dry = row({ pnl: 999, status: 'dry_run' });
  const notes = { [filled.order_id]: { tags: ['t'] }, [dry.order_id]: { tags: ['t'] } };
  assert.strictEqual(taggedStats([filled, dry], notes).tags[0].trades, 1, 'the confirmed view');
  assert.strictEqual(taggedStats([filled, dry], notes, { view: 'all' }).tags[0].trades, 2, 'the strategy view');
});
