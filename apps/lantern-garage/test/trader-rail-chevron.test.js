'use strict';
/**
 * test/trader-rail-chevron.test.js — the drawing rail's flyout chevron sits BESIDE its
 * icon, not on top of it (founder, 2026-09-16).
 *
 * It was absolutely positioned at the icon button's own right edge: in a 44px rail with a
 * 36px button, that put it over the last few pixels of the glyph. It has its own strip
 * now, and the rail column is wide enough to hold both.
 *
 * Run: node --test apps/lantern-garage/test/trader-rail-chevron.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const rule = (sel) => {
  const at = PAGE.indexOf('\n  ' + sel + '{');
  assert.notStrictEqual(at, -1, 'no rule for ' + sel);
  return PAGE.slice(at, PAGE.indexOf('}', at) + 1);
};
const px = (block, prop) => {
  // `right:0` is as valid as `right:0px`, and the chevron is written the short way.
  const m = block.match(new RegExp('(?:^|[;{\\s])' + prop + ':(-?\\d+)(?:px)?(?=[;}\\s])'));
  assert.ok(m, prop + ' not set in: ' + block.slice(0, 120));
  return +m[1];
};

test('the chevron is beside the icon, with no overlap', () => {
  const cat = rule('.dr-cat'), btn = rule('.dr-cat .dr-btn'), more = rule('.dr-more');
  const catW = px(cat, 'width'), btnW = px(btn, 'width'), moreW = px(more, 'width'), right = px(more, 'right');
  assert.strictEqual(right, 0, 'the chevron hangs off the slot rather than sitting in it');
  // its left edge, measured from the slot's left, must clear the icon button entirely
  const moreLeft = catW - right - moreW;
  assert.ok(moreLeft >= btnW, 'the chevron starts at ' + moreLeft + 'px, over a ' + btnW + 'px icon button');
  assert.strictEqual(catW, btnW + moreW, 'the slot is not exactly the icon plus the chevron');
});

test('the rail column is wide enough for the icon and the chevron', () => {
  const rail = rule('.draw-rail');
  const pad = rail.match(/padding:(\d+)px (\d+)px/);
  assert.ok(pad, 'the rail has no padding rule');
  const layout = rule('.layout');
  const col = layout.match(/grid-template-columns:(\d+)px/);
  assert.ok(col, 'the rail column is no longer a fixed width');
  // The rail's own right border eats a pixel of the column, which is what made the slot
  // overflow and gave the rail a sideways scrollbar.
  const border = rail.match(/border-right:(\d+)px/);
  const inner = +col[1] - 2 * +pad[2] - (border ? +border[1] : 0);
  assert.ok(inner >= px(rule('.dr-cat'), 'width'), 'the slot does not fit: ' + inner + 'px of room');
  // packed to the start, so a utility button's glyph lines up with a category's
  assert.match(rail, /align-items:flex-start/);
});

test('it is invisible until the slot is hovered, and lights up on its own hover', () => {
  const more = rule('.dr-more');
  assert.match(more, /opacity:0/, 'the chevron is visible when nothing is hovered');
  assert.match(more, /transition:opacity [^;]*,color [^;]*,background/, 'the highlight snaps rather than fading');
  const shown = PAGE.slice(PAGE.indexOf('.dr-cat:hover .dr-more'), PAGE.indexOf('}', PAGE.indexOf('.dr-cat:hover .dr-more')) + 1);
  assert.match(shown, /\.dr-cat:hover \.dr-more,\.dr-more:focus-visible,\.dr-more\[aria-expanded="true"\]\{opacity:1\}/,
    'hovering the icon no longer reveals it');
  const hot = PAGE.slice(PAGE.indexOf('.dr-more:hover'), PAGE.indexOf('}', PAGE.indexOf('.dr-more:hover')) + 1);
  assert.match(hot, /color:var\(--accent\)/, 'the chevron does not light up when hovered');
  assert.match(hot, /background:var\(--bg3\)/);
});
