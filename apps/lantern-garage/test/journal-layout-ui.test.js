'use strict';
/**
 * test/journal-layout-ui.test.js — #3543, reworked for real editing in #3565.
 *
 * The rules the reader's arrangement follows, driven as the page's own functions.
 *
 * The bug that prompted the rework is pinned here as its own case: a drop used to mean
 * "before the card you released on", which is right going one way, off by one going the
 * other, and left the final position unreachable. The model now takes a SLOT, which has
 * no direction in it.
 *
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
  'const JP_COLS = 12, JP_SPAN_MIN = 3, JP_H_MIN = 120, JP_H_MAX = 1200;',
  grabDecl('JP_WIDGETS'),
  'const JP_WIDGET = {}; JP_WIDGETS.forEach((w) => { JP_WIDGET[w.id] = w; });',
  grabDecl('jpSpanOk'), grabDecl('jpHeightOk'), grabDecl('jpClamp'), grabDecl('_l2'),
  grabFn('jpLayoutDefault'), grabFn('jpLayoutMerge'),
  grabDecl('jpSpanOf'), grabDecl('jpHeightOf'),
  grabFn('jpLayoutMove'), grabFn('jpLayoutInsert'), grabFn('jpLayoutSpan'), grabFn('jpLayoutHeight'),
  grabDecl('jpLayoutHide'), grabDecl('jpLayoutShow'),
].join('\n');
const P = new Function(CODE + '\nreturn { JP_WIDGETS, JP_COLS, jpLayoutDefault, jpLayoutMerge, jpSpanOf, jpHeightOf,'
  + ' jpLayoutMove, jpLayoutInsert, jpLayoutSpan, jpLayoutHeight, jpLayoutHide, jpLayoutShow };')();
const ids = P.JP_WIDGETS.map((w) => w.id);

test('the registry is sound, and its ids are ones the store will accept', () => {
  assert.ok(ids.length >= 5);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const w of P.JP_WIDGETS) {
    assert.match(w.id, /^[a-z][a-z0-9-]{0,31}$/, w.id);
    assert.ok(w.name && w.name.length > 2, w.id + ' has a name for the reader');
    assert.ok(Number.isInteger(w.w) && w.w >= 3 && w.w <= 12, w.id + ' has a default span in twelfths');
  }
  assert.ok(store.normalize(P.jpLayoutDefault()), 'the default layout is storable as-is');
});

test('the default shows everything, in the registry order, at no explicit size', () => {
  assert.deepStrictEqual(P.jpLayoutDefault(), { v: 2, order: ids, hidden: [], span: {}, h: {} });
});

test('a missing or unusable stored layout falls back to the default', () => {
  for (const bad of [null, undefined, {}, { order: 'nope' }, 42]) {
    assert.deepStrictEqual(P.jpLayoutMerge(bad), P.jpLayoutDefault(), JSON.stringify(bad));
  }
});

test('a card the page no longer has is dropped; a card the layout never knew is appended', () => {
  const stored = { v: 2, order: ['breakdown', 'gone-card', ids[0]], hidden: ['gone-card'], span: { 'gone-card': 6 }, h: {} };
  const merged = P.jpLayoutMerge(stored);
  assert.strictEqual(merged.order.includes('gone-card'), false, 'a card that no longer exists disappears');
  assert.deepStrictEqual(merged.order.slice(0, 2), ['breakdown', ids[0]], 'the reader\'s order is kept');
  assert.deepStrictEqual(merged.order.slice().sort(), ids.slice().sort(), 'every current card is present');
  assert.deepStrictEqual(merged.hidden, [], 'hiding a card that is gone means nothing');
  assert.deepStrictEqual(merged.span, {}, 'and neither does its width');
});

test('a layout saved under the old half-or-full model still opens (#3565)', () => {
  const v1 = { v: 1, order: ids.slice(), hidden: ['placements'], width: { calendar: 2, breakdown: 1 } };
  const merged = P.jpLayoutMerge(v1);
  assert.strictEqual(P.jpSpanOf(merged, 'calendar'), 12, 'full became the full width');
  assert.strictEqual(P.jpSpanOf(merged, 'breakdown'), 6, 'half became six twelfths');
  assert.deepStrictEqual(merged.hidden, ['placements'], 'and what they hid stays hidden');
});

test('moving a card: neighbours swap, and the ends hold', () => {
  const l = P.jpLayoutDefault();
  assert.deepStrictEqual(P.jpLayoutMove(l, ids[0], -1).order, ids, 'the first card cannot move earlier');
  assert.deepStrictEqual(P.jpLayoutMove(l, ids[ids.length - 1], 1).order, ids, 'the last cannot move later');
  assert.deepStrictEqual(P.jpLayoutMove(l, ids[0], 1).order.slice(0, 2), [ids[1], ids[0]]);
  assert.deepStrictEqual(l.order, ids, 'the original layout is untouched');
});

test('dropping into a slot works the same in BOTH directions (#3565)', () => {
  // The old model could only say "before the card you dropped on". Going up that is what
  // you meant; going down it is one short of it.
  const l = P.jpLayoutDefault();
  const down = P.jpLayoutInsert(l, ids[0], 3).order;
  assert.deepStrictEqual(down.slice(0, 3), [ids[1], ids[2], ids[0]], 'moved down into the third slot');
  const up = P.jpLayoutInsert(l, ids[3], 1).order;
  assert.deepStrictEqual(up.slice(0, 4), [ids[0], ids[3], ids[1], ids[2]], 'and up into the first');
  assert.strictEqual(down.length, ids.length, 'nothing lost or duplicated either way');
  assert.strictEqual(new Set(down).size, ids.length);
});

test('a card CAN be dropped at the very end — the position the old drag could not reach', () => {
  const l = P.jpLayoutDefault();
  const moved = P.jpLayoutInsert(l, ids[0], ids.length).order;
  assert.strictEqual(moved[moved.length - 1], ids[0], 'it lands last, not second to last');
  assert.strictEqual(moved.length, ids.length);
});

test('dropping a card back where it already is changes nothing', () => {
  const l = P.jpLayoutDefault();
  assert.strictEqual(P.jpLayoutInsert(l, ids[2], 2), l, 'the slot before it');
  assert.strictEqual(P.jpLayoutInsert(l, ids[2], 3), l, 'and the slot after it');
  assert.strictEqual(P.jpLayoutInsert(l, 'not-a-card', 1), l);
});

test('an out-of-range slot lands at the nearest end rather than corrupting the order', () => {
  const l = P.jpLayoutDefault();
  assert.strictEqual(P.jpLayoutInsert(l, ids[5], -99).order[0], ids[5]);
  assert.strictEqual(P.jpLayoutInsert(l, ids[0], 9999).order.slice(-1)[0], ids[0]);
});

test('slots are counted among VISIBLE cards, and hidden ones keep their place', () => {
  let l = P.jpLayoutHide(P.jpLayoutDefault(), ids[1]);
  const visible = l.order.filter((x) => !l.hidden.includes(x));
  l = P.jpLayoutInsert(l, visible[0], 2);
  const after = l.order.filter((x) => !l.hidden.includes(x));
  assert.strictEqual(after[1], visible[0], 'it moved to the second visible slot');
  assert.ok(l.order.includes(ids[1]), 'and the hidden card was not dropped on the way');
  assert.deepStrictEqual(l.hidden, [ids[1]]);
});

test('width is any span from a quarter to the full page', () => {
  const l = P.jpLayoutDefault();
  assert.strictEqual(P.jpSpanOf(l, 'calendar'), 6, 'defaults come from the registry');
  assert.strictEqual(P.jpSpanOf(l, 'kpis'), 12);
  for (const [asked, got] of [[3, 3], [7, 7], [12, 12], [1, 3], [99, 12], [6.4, 6]]) {
    assert.strictEqual(P.jpSpanOf(P.jpLayoutSpan(l, 'calendar', asked), 'calendar'), got, 'span ' + asked);
  }
  assert.deepStrictEqual(l.span, {}, 'the original layout is untouched');
});

test('height is the reader\'s, and can be given back', () => {
  const l = P.jpLayoutDefault();
  assert.strictEqual(P.jpHeightOf(l, 'calendar'), null, 'a card sizes to its contents until told otherwise');
  const tall = P.jpLayoutHeight(l, 'calendar', 400);
  assert.strictEqual(P.jpHeightOf(tall, 'calendar'), 400);
  assert.strictEqual(P.jpHeightOf(P.jpLayoutHeight(tall, 'calendar', 10), 'calendar'), 120, 'clamped, not unreadable');
  assert.strictEqual(P.jpHeightOf(P.jpLayoutHeight(tall, 'calendar', 99999), 'calendar'), 1200);
  assert.strictEqual(P.jpHeightOf(P.jpLayoutHeight(tall, 'calendar', null), 'calendar'), null, 'and back to auto');
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
  l = P.jpLayoutSpan(l, 'calendar', 7);
  l = P.jpLayoutSpan(l, 'balance', 5);
  l = P.jpLayoutHeight(l, 'balance', 340);
  l = P.jpLayoutHide(l, 'placements');
  l = P.jpLayoutInsert(l, 'pnlday', 0);
  const kept = store.normalize(l);
  assert.deepStrictEqual(kept, { v: 2, order: l.order, hidden: l.hidden, span: l.span, h: l.h });
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

test('a card the reader has sized is sized by its contents, not by its row (#3567)', () => {
  /* Rows stretch so un-sized cards line up. But a stretched grid item's height comes from
     its ROW, so setting a height on the body could not move the box around it: the card
     grew a scrollbar and its outline never budged. Measured before the fix — body 230 to
     120, card 380 to 380. A card with an explicit height has to leave the stretch. */
  const paint = grabFn('jpPaintCards');
  assert.match(paint, /align-self:start/, 'a sized card opts out of the row stretch');
  assert.match(paint, /h \? ';align-self:start' : ''/, 'and only when a height was actually set');
  const grid = src.slice(src.indexOf('.jp-cards{'), src.indexOf('.jp-cards{') + 200);
  assert.match(grid, /align-items:stretch/, 'while everything else still lines up across the row');
});

test('the editing surface is drag-first, with the keyboard able to do the same things', () => {
  const bind = grabFn('jpBindLayout');
  assert.match(bind, /pointerdown/, 'dragging is pointer-based');
  assert.match(bind, /pointercancel/, 'and a cancelled gesture cannot strand the page mid-drag');
  assert.doesNotMatch(bind, /dragstart|dataTransfer/, 'HTML5 drag-and-drop is gone with its off-by-one');
  assert.match(bind, /jpLayoutInsert/, 'a drop is a slot');
  assert.match(bind, /jpLayoutSpan/, 'an edge drag is a width');
  assert.match(bind, /jpLayoutHeight/, 'and a bottom drag is a height');
  assert.match(bind, /shiftKey/, 'the keyboard resizes too, which the old arrows could not');
  const bar = grabFn('jpCardBar');
  assert.doesNotMatch(bar, /◀|▶/, 'the arrow chips are gone');
  assert.match(bar, /data-grip=/, 'replaced by a grip that drags and takes focus');
});
