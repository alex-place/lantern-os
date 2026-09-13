'use strict';
/**
 * test/bar-window.test.js — #3561.
 *
 * `bar-archive` has written this corpus since #3165 and nothing ever read it back. The
 * contract here is narrow and worth pinning: a window is the bars inside it and nothing
 * else, what the archive HOLDS is reported alongside (so a caller can say why a window
 * came back short), and a coarse timeframe on disk is preferred over rolling one up out
 * of 5m — a rolled-up bar over a hole in the 5m data looks complete and is not.
 *
 * Run: node --test apps/lantern-garage/test/bar-window.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barwin-'));
process.env.BAR_ARCHIVE_DIR = DIR;
const W = require('../lib/bar-window');

const T = (s) => Date.parse(s);
const write = (sym, tf, rows) => {
  fs.writeFileSync(path.join(DIR, `${sym}-${tf}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  W._clearCache();
};
const series = (startIso, n, stepMs, p0) => Array.from({ length: n }, (_, i) => ({
  t: new Date(T(startIso) + i * stepMs).toISOString(), o: p0 + i, h: p0 + i + 1, l: p0 + i - 1, c: p0 + i, v: 10,
}));

test('a window is the bars inside it, and nothing either side', () => {
  write('SPY', '5m', series('2026-09-09T13:30:00Z', 60, 300000, 700));
  const w = W.readWindow('SPY', '5m', T('2026-09-09T14:00:00Z'), T('2026-09-09T14:30:00Z'));
  assert.strictEqual(w.bars.length, 7, 'inclusive at both ends');
  assert.strictEqual(w.bars[0].t, T('2026-09-09T14:00:00Z'));
  assert.strictEqual(w.bars[w.bars.length - 1].t, T('2026-09-09T14:30:00Z'));
});

test('what the archive holds comes back with the window, short or not', () => {
  write('SPY', '5m', series('2026-09-09T13:30:00Z', 60, 300000, 700));
  const miss = W.readWindow('SPY', '5m', T('2026-01-01T00:00:00Z'), T('2026-01-02T00:00:00Z'));
  assert.strictEqual(miss.bars.length, 0);
  assert.strictEqual(miss.held.count, 60, 'so the caller can say WHY it was empty');
  assert.strictEqual(miss.held.first, T('2026-09-09T13:30:00Z'));
});

test('a symbol with no file is empty rather than an error', () => {
  const w = W.readWindow('NOTHING', '5m', 0, Date.now());
  assert.deepStrictEqual(w.bars, []);
  assert.strictEqual(w.held.count, 0);
});

test('a torn tail line is skipped, not fatal — the archiver appends while we read', () => {
  const rows = series('2026-09-09T13:30:00Z', 5, 300000, 100).map((r) => JSON.stringify(r));
  fs.writeFileSync(path.join(DIR, 'TORN-5m.jsonl'), rows.join('\n') + '\n{"t":"2026-09-09T13:5');
  W._clearCache();
  assert.strictEqual(W.have('TORN', '5m').count, 5);
});

test('a row with no usable close is not a bar', () => {
  fs.writeFileSync(path.join(DIR, 'BAD-5m.jsonl'), [
    JSON.stringify({ t: '2026-09-09T13:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 0 }),
    JSON.stringify({ t: '2026-09-09T13:35:00Z', o: 1, h: 1, l: 1, c: null, v: 0 }),
    JSON.stringify({ t: 'not a time', o: 1, h: 1, l: 1, c: 1, v: 0 }),
  ].join('\n') + '\n');
  W._clearCache();
  assert.strictEqual(W.have('BAD', '5m').count, 1);
});

test('a coarse timeframe on disk beats rolling one up out of 5m', () => {
  /* The archiver keeps whatever the server fetches, so 1h bars may be REAL. Preferring
     them is not an optimisation: a 1h candle rolled up over a hole in the 5m corpus looks
     complete and is not. */
  write('DUAL', '1h', series('2026-09-09T13:00:00Z', 8, 3600000, 50));
  write('DUAL', '5m', series('2026-09-09T13:00:00Z', 96, 300000, 50));
  const best = W.bestWindow('DUAL', '1h', T('2026-09-09T13:00:00Z'), T('2026-09-09T20:00:00Z'));
  assert.strictEqual(best.tf, '1h');
  assert.strictEqual(best.bars.length, 8);
});

test('when the coarse file does not cover the window, finer data is used and named', () => {
  write('FINE', '1h', series('2026-01-01T13:00:00Z', 4, 3600000, 50));     // an old, unrelated stretch
  write('FINE', '5m', series('2026-09-09T13:00:00Z', 96, 300000, 50));
  const best = W.bestWindow('FINE', '1h', T('2026-09-09T13:00:00Z'), T('2026-09-09T16:00:00Z'));
  assert.strictEqual(best.tf, '5m', 'so the caller knows it will have to roll up');
  assert.ok(best.bars.length > 30);
});

test('nothing anywhere reports the richest archive we hold, so the message names a real file', () => {
  write('WIDE', '5m', series('2026-07-01T13:00:00Z', 90, 300000, 50));
  write('WIDE', '1h', series('2026-07-01T13:00:00Z', 3, 3600000, 50));
  const best = W.bestWindow('WIDE', '1h', T('2026-09-09T13:00:00Z'), T('2026-09-09T16:00:00Z'));
  assert.strictEqual(best.bars.length, 0);
  assert.strictEqual(best.held.count, 90, 'the 5m file is the widest thing we have on this symbol');
});

test('a symbol name cannot escape the archive directory', () => {
  /* The sanitiser is deliberately CHARACTER-IDENTICAL to bar-archive's: the reader has to
     resolve the same filename the writer chose, so hardening one side alone would make
     the corpus unreadable. What matters is that no separator survives, which is what
     keeps every resolved path inside the directory. */
  for (const nasty of ['../../etc/passwd', '..' + String.fromCharCode(92) + '..', 'a/b/c', 'SPY' + String.fromCharCode(0) + 'x']) {
    const f = W.fileFor(nasty, '5m');
    assert.strictEqual(path.dirname(path.resolve(f)), path.resolve(DIR), nasty);
  }
});

test('re-reading the same file does not re-parse it', () => {
  write('CACHE', '5m', series('2026-09-09T13:30:00Z', 200, 300000, 100));
  const a = W.load('CACHE', '5m');
  const b = W.load('CACHE', '5m');
  assert.strictEqual(a, b, 'the same array, not an equal one');
});

test('an appended file is re-read rather than served stale', () => {
  write('GROW', '5m', series('2026-09-09T13:30:00Z', 10, 300000, 100));
  assert.strictEqual(W.have('GROW', '5m').count, 10);
  fs.appendFileSync(path.join(DIR, 'GROW-5m.jsonl'),
    JSON.stringify({ t: '2026-09-09T14:20:00Z', o: 1, h: 1, l: 1, c: 1, v: 0 }) + '\n');
  // The cache is keyed on (size, mtime); size alone settles this one.
  assert.strictEqual(W.have('GROW', '5m').count, 11);
});
