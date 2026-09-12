'use strict';
/**
 * test/journal-notes-ui.test.js — #3559.
 *
 * The editor sits inside the trade log's expanded row, so what is pinned here is that it
 * only ever offers to annotate something real, that a tag can be taken back as easily as
 * it was added, and that the tag table does not exist until there is something in it.
 *
 * Run: node --test apps/lantern-garage/test/journal-notes-ui.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
  assert.ok(i >= 0, 'function not found: ' + name);
  let depth = 0, started = false;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};
const grabDecl = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const P = new Function([
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpSign'),
  grabDecl('JP_FEELINGS'),
  'let jpNotes = {}; let jpNoteTags = []; let jpData = { demo: false };',
  grabDecl('jpNoteOf'),
  grabFn('jpNoteEditor'), grabFn('jpTags'),
].join('\n') + '\nreturn { JP_FEELINGS, jpNoteEditor, jpTags,'
  + ' setNotes: (n) => { jpNotes = n; }, setKnown: (t) => { jpNoteTags = t; }, setDemo: (d) => { jpData = { demo: d }; } };')();

const trade = { id: 'o1', symbol: 'AAPL', pnl: 50 };

test('an untouched trade offers an empty editor, not a filled one', () => {
  P.setNotes({});
  const html = P.jpNoteEditor(trade);
  assert.match(html, /<textarea/);
  assert.match(html, /placeholder="What happened, in your words/);
  assert.doesNotMatch(html, /class="jp-tag"/, 'no tag chips until there are tags');
  assert.strictEqual((html.match(/jp-chip on/g) || []).length, 0, 'and no feeling is preselected');
});

test('what the reader wrote comes back into the editor', () => {
  P.setNotes({ o1: { note: 'chased the open', tags: ['chased', 'news gap'], feel: 'anxious' } });
  const html = P.jpNoteEditor(trade);
  assert.match(html, /chased the open/);
  assert.match(html, /jpNoteTag\('o1', 'chased', false\)/, 'each tag is a chip that removes itself');
  assert.match(html, /jpNoteTag\('o1', 'news gap', false\)/);
  assert.match(html, /jp-chip on" onclick="jpNoteFeel\('o1', 'anxious'\)/, 'and the feeling is selected');
  assert.match(html, /jpNoteFeel\('o1', null\)/, 'with a way to unset it');
});

test('the feelings offered are the short fixed list the aggregate needs', () => {
  // Free text cannot be aggregated, and one trade's mood is worth nothing while forty
  // are worth something.
  assert.deepStrictEqual(P.JP_FEELINGS, ['calm', 'confident', 'unsure', 'anxious', 'frustrated']);
  const html = P.jpNoteEditor(trade);
  for (const f of P.JP_FEELINGS) assert.match(html, new RegExp('>' + f + '<'));
});

test('tags the reader has used before are offered, so the next one is a pick not a typo', () => {
  P.setNotes({});
  P.setKnown([{ tag: 'breakout', n: 9 }, { tag: 'chased', n: 4 }]);
  const html = P.jpNoteEditor(trade);
  assert.match(html, /<datalist id="jpTagList">/);
  assert.match(html, /<option value="breakout">/);
  assert.match(html, /list="jpTagList"/, 'and the input is wired to it');
});

test('the demo book gets an explanation, not an editor that goes nowhere', () => {
  // The demo book is simulated and regenerates, so a note on it would attach to a trade
  // that is not the reader's and will not be there tomorrow.
  P.setDemo(true);
  const html = P.jpNoteEditor(trade);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /jpNoteTag/);
  assert.match(html, /go on your own trades/);
  P.setDemo(false);
});

test('a hostile tag or note cannot smuggle markup into the row', () => {
  P.setNotes({ o1: { note: '<img src=x onerror=alert(1)>', tags: ['<script>'], feel: null } });
  const html = P.jpNoteEditor(trade);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
});

test('the tag table does not exist until something is tagged', () => {
  // A card that only ever says "nothing here yet" is clutter on a new reader's journal;
  // the editor in the trade log is where the feature is discovered.
  assert.strictEqual(P.jpTags(null), '');
  assert.strictEqual(P.jpTags({ trades: 40, annotated: 0, tags: [], feelings: [] }), '');
});

test('tags are priced, and the table says how much of the book it speaks for', () => {
  const stats = {
    trades: 40, annotated: 12,
    tags: [{ key: 'chased', trades: 4, winRate: 0, totalRealized: -210, expectancy: -52.5 }],
    feelings: [{ key: 'anxious', trades: 4, winRate: 0, totalRealized: -210, expectancy: -52.5 }],
  };
  const html = P.jpTags(stats);
  assert.match(html, /chased/);
  assert.match(html, /-\$210\.00/);
  assert.match(html, /-\$52\.50/, 'per trade is the number worth having');
  assert.match(html, /Written about 12 of 40 closed trades/);
  assert.match(html, /Felt/, 'and feelings get their own table');
});

test('a thin sample says so rather than reading as a finding', () => {
  const thin = { trades: 200, annotated: 3, tags: [{ key: 'x', trades: 3, winRate: 100, totalRealized: 9, expectancy: 3 }], feelings: [] };
  assert.match(P.jpTags(thin), /too few yet to read as a finding/);
  const solid = { trades: 200, annotated: 60, tags: thin.tags, feelings: [] };
  assert.doesNotMatch(P.jpTags(solid), /too few yet/);
});

test('writing a note repaints the card and never re-reads the record', () => {
  const save = grabFn('jpNoteSave');
  assert.match(save, /\/api\/journal\/notes/, 'journal personalisation, not the trading API');
  assert.doesNotMatch(save, /jpLoad\(/, 'annotating never refetches the trades');
  const paint = grabFn('jpNotePaint');
  assert.match(paint, /jpTradesCard/);
  assert.match(paint, /jpTagsLoad\(\)/, 'and the tag table follows, so the two cannot disagree');
});

test('the editor fits the screen it is on, not the table it sits in', () => {
  // It lives in a cell of a table that scrolls sideways, so it inherited the TABLE's
  // width -- 485px inside a 375px screen, which meant scrolling right to type.
  const css = src.slice(src.indexOf('.jp-note-edit{'), src.indexOf('.jp-note-edit{') + 260);
  assert.match(css, /position:sticky/);
  assert.match(css, /width:100cqi/, 'the container being the scroll box, not the table');
  assert.match(src, /\.jp-trades-scroll\{container-type:inline-size\}/);
});
