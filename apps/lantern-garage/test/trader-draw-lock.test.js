'use strict';
/**
 * test/trader-draw-lock.test.js — Lock locks (2026-09-16).
 *
 * It was checked in exactly one place: the branch that starts a BODY drag. So a locked
 * drawing could still be dragged by its handles, deleted with the Delete key, alt-clicked
 * away, or erased by the eraser — everything a lock exists to prevent, except the one
 * gesture the check happened to be written next to.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-lock.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => {
  const at = PAGE.indexOf('function ' + name + '(');
  assert.notStrictEqual(at, -1, name + ' not found');
  return PAGE.slice(at, PAGE.indexOf('\n}\n', at) + 3);
};

test('one place answers whether a drawing is locked, and it says so', () => {
  const src = fn('drawLocked');
  assert.match(src, /if \(!d \|\| !d\.locked\) return false;/);
  assert.match(src, /_alertToast\('That drawing is locked/, 'a refusal with no explanation is a dead click');
  const locked = new Function('_drawings', '_alertToast', src + '\nreturn drawLocked;');
  const said = [];
  const ask = locked({ SPY: [{ t: 'l' }, { t: 'l', locked: true }] }, (m) => said.push(m));
  assert.strictEqual(ask('SPY', 0, 'delete it'), false, 'an unlocked drawing is not protected');
  assert.deepStrictEqual(said, [], 'and nothing is said about it');
  assert.strictEqual(ask('SPY', 1, 'delete it'), true);
  assert.match(said[0], /locked — unlock it to delete it\./);
  assert.strictEqual(ask('SPY', 9, 'delete it'), false, 'a drawing that is not there is not locked');
});

test('every way of removing a drawing asks first', () => {
  assert.match(fn('deleteDrawing'), /^function deleteDrawing\(tk, i\) \{\n  if \(drawLocked\(tk, i, 'delete it'\)\) return;/,
    'the toolbar bin and the Delete key go through here');
  assert.match(fn('_deleteNearestDrawing'), /if \(drawLocked\(tk, hit\.i, 'erase it'\)\) return false;/,
    'the eraser and alt-click go through here');
  // the Delete key really does route through deleteDrawing
  const keys = PAGE.slice(PAGE.indexOf("if (e.key !== 'Delete' && e.key !== 'Backspace') return;"), PAGE.indexOf('/* -- Per-drawing settings'));
  assert.match(keys, /deleteDrawing\(_selDraw\.tk, _selDraw\.i\);/);
});

test('a locked drawing has no draggable handles', () => {
  const down = PAGE.slice(PAGE.indexOf('const _HANDLE_R = 5;'), PAGE.indexOf('/* Rubber band.'));
  assert.match(down, /if \(_selDraw && _selDraw\.tk === tk && !\(_drawings\[tk\]\[_selDraw\.i\] \|\| \{\}\)\.locked\) \{/,
    'the handle branch still ignores the lock');
  // and the body-drag branch keeps the check it always had
  assert.match(down, /if \(\(_drawings\[tk\]\[hit\.i\] \|\| \{\}\)\.locked\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); _refreshTicker\(tk\); return; \}/);
  // selecting it is still allowed: that is how you reach the unlock button
  assert.ok(down.indexOf('_selDraw = { tk, i: hit.i }') < down.indexOf('.locked) { e.stopPropagation()'),
    'a locked drawing must still select, or it can never be unlocked');
});
