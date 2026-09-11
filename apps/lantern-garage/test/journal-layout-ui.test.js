'use strict';
/**
 * test/journal-layout-ui.test.js — #3543.
 *
 * The rules the reader's arrangement follows, driven as the page's own functions:
 * reorder, resize, hide, restore — and what happens to a stored layout when the page
 * gains or loses a card, which is the case that quietly strands people on a layout that
 * hides the new thing by omission.
 * Run: node --test apps/lantern-garage/test/journal-layout-ui.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/journal-layout');

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

const CODE = [
  grabDecl('JP_WIDGETS'),
  'const JP_WIDGET = {}; JP_WIDGETS.forEach((w) => { JP_WIDGET[w.id] = w; });',
  grabFn('jpLayoutDefault'),
  grabFn('jpLayoutMerge'),
  grabDecl('jpWidthOf'),
  grabFn('jpLayoutMove'),
  grabFn('jpLayoutPlace'),
  grabFn('jpLayoutWidth'),
  grabDecl('jpLayoutHide'),
  grabDecl('jpLayoutShow'),
].join('\n');
const P = new Function(CODE + '\nreturn { JP_WIDGETS, jpLayoutDefault, jpLayoutMerge, jpWidthOf, jpLayoutMove, jpLayoutPlace, jpLayoutWidth, jpLayoutHide, jpLayoutShow };')();
const ids = P.JP_WIDGETS.map((w) => w.id);

test('the registry is sound, and its ids are ones the store will accept', () => {
  assert.ok(ids.length >= 5);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const w of P.JP_WIDGETS) {
    assert.match(w.id, /^[a-z][a-z0-9-]{0,31}$/, w.id);
    assert.ok(w.name && w.name.length > 2, w.id + ' has a name for the reader');
    assert.ok(w.w === 1 || w.w === 2, w.id + ' is half or full width');
  }
  assert.ok(store.normalize(P.jpLayoutDefault()), 'the default layout is storable as-is');
});

test('the default shows everything, in the registry order', () => {
  assert.deepStrictEqual(P.jpLayoutDefault(), { v: 1, order: ids, hidden: [], width: {} });
});

test('a missing or unusable stored layout falls back to the default', () => {
  for (const bad of [null, undefined, {}, { order: 'nope' }, 42]) {
    assert.deepStrictEqual(P.jpLayoutMerge(bad), P.jpLayoutDefault(), JSON.stringify(bad));
  }
});

test('a card the page no longer has is dropped; a card the layout never knew is appended', () => {
  const stored = { v: 1, order: ['breakdown', 'gone-card', ids[0]], hidden: ['gone-card'], width: { 'gone-card': 2 } };
  const merged = P.jpLayoutMerge(stored);
  assert.strictEqual(merged.order.includes('gone-card'), false, 'a card that no longer exists disappears');
  assert.deepStrictEqual(merged.order.slice(0, 2), ['breakdown', ids[0]], 'the reader\'s order is kept');
  assert.deepStrictEqual(merged.order.slice().sort(), ids.slice().sort(), 'every current card is present');
  assert.deepStrictEqual(merged.hidden, [], 'hiding a card that is gone means nothing');
  assert.deepStrictEqual(merged.width, {}, 'and neither does its width');
});

test('moving a card: neighbours swap, and the ends hold', () => {
  const l = P.jpLayoutDefault();
  assert.deepStrictEqual(P.jpLayoutMove(l, ids[0], -1).order, ids, 'the first card cannot move earlier');
  assert.deepStrictEqual(P.jpLayoutMove(l, ids[ids.length - 1], 1).order, ids, 'the last cannot move later');
  const moved = P.jpLayoutMove(l, ids[0], 1).order;
  assert.deepStrictEqual(moved.slice(0, 2), [ids[1], ids[0]]);
  assert.deepStrictEqual(l.order, ids, 'the original layout is untouched');
});

test('dropping a card puts it where it was dropped', () => {
  const l = P.jpLayoutDefault();
  const dropped = P.jpLayoutPlace(l, ids[3], ids[1]).order;
  assert.deepStrictEqual(dropped.slice(0, 3), [ids[0], ids[3], ids[1]], 'it lands before the card it was dropped on');
  assert.strictEqual(dropped.length, ids.length, 'nothing is lost or duplicated');
  assert.deepStrictEqual(P.jpLayoutPlace(l, ids[2], ids[2]).order, ids, 'dropping a card on itself changes nothing');
  assert.deepStrictEqual(P.jpLayoutPlace(l, 'not-a-card', ids[1]).order, ids, 'and an unknown card changes nothing');
});

test('width is half or full, and falls back to what the card was built for', () => {
  const l = P.jpLayoutDefault();
  assert.strictEqual(P.jpWidthOf(l, 'calendar'), 1);
  assert.strictEqual(P.jpWidthOf(l, 'kpis'), 2, 'the tiles span the page by default');
  const wide = P.jpLayoutWidth(l, 'calendar', 2);
  assert.strictEqual(P.jpWidthOf(wide, 'calendar'), 2);
  assert.strictEqual(P.jpWidthOf(P.jpLayoutWidth(wide, 'calendar', 1), 'calendar'), 1);
  assert.strictEqual(P.jpWidthOf(P.jpLayoutWidth(l, 'calendar', 9), 'calendar'), 1, 'anything else means half');
});

test('hiding and restoring', () => {
  const l = P.jpLayoutDefault();
  const hidden = P.jpLayoutHide(l, 'balance');
  assert.deepStrictEqual(hidden.hidden, ['balance']);
  assert.deepStrictEqual(P.jpLayoutHide(hidden, 'balance').hidden, ['balance'], 'hiding twice hides once');
  assert.deepStrictEqual(P.jpLayoutHide(l, 'not-a-card').hidden, [], 'a card that is not there cannot be hidden');
  assert.deepStrictEqual(P.jpLayoutShow(hidden, 'balance').hidden, []);
  assert.deepStrictEqual(hidden.order, ids, 'hiding keeps a card in the order, so restoring it puts it back where it was');
});

test('every arrangement the page can make is one the store will keep', () => {
  let l = P.jpLayoutDefault();
  l = P.jpLayoutMove(l, 'breakdown', -1);
  l = P.jpLayoutWidth(l, 'calendar', 2);
  l = P.jpLayoutHide(l, 'placements');
  l = P.jpLayoutPlace(l, 'pnlday', 'kpis');
  const kept = store.normalize(l);
  assert.deepStrictEqual(kept, { v: 1, order: l.order, hidden: l.hidden, width: l.width });
});

test('the page saves on change and asks the server for the reader\'s own on load', () => {
  const apply = grabFn('jpApplyLayout');
  assert.match(apply, /localStorage\.setItem\(JP_LAYOUT_KEY/, 'the browser copy is written first');
  assert.match(apply, /fetch\('\/api\/journal\/layout', \{ method: 'POST'/, 'and the account copy follows');
  assert.match(apply, /jpPaintCards\(\)/, 'the cards repaint from data already in hand');
  assert.doesNotMatch(apply, /jpLoad\(/, 'arranging the page never refetches the record');
  assert.match(grabFn('jpLayoutSync'), /\/api\/journal\/layout/);
  assert.match(grabFn('jpLayoutReset'), /method: 'DELETE'/);
});
