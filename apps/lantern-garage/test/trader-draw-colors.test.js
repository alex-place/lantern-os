'use strict';
/**
 * test/trader-draw-colors.test.js — a drawing's colours are editable and honest, and a
 * shape survives the deck rebuilding under it (founder, 2026-09-15).
 *
 *   "i cant edit the color of the multi colored drawing tools. and the drawing tool shapes
 *    like circle, rectangle, etc... are also bugged, when i try to place them they just
 *    colapse in 1 point instead of actually being drawn"
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-colors.test.js
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

// The catalogue and its colour helpers, evaluated the way the page builds them.
const specStart = PAGE.indexOf('const FIB_COLORS = {');
const specEnd = PAGE.indexOf('\nconst drawSpecOf', specStart);
assert.ok(specStart > 0 && specEnd > specStart, 'DRAW_SPEC block not found');
const catStart = PAGE.indexOf('const DRAW_CAT_COLOR = {');
const catEnd = PAGE.indexOf('\n}\n', PAGE.indexOf('function drawDefaultColor', catStart)) + 3;
const env = new Function('DRAW_COLOR', 'DRAW_TOOLS',
  PAGE.slice(catStart, catEnd) + PAGE.slice(specStart, specEnd)
  + '\nreturn { DRAW_SPEC, DRAW_CAT_COLOR, drawDefaultColor, FIB_COLORS, drawSpecOf: (t) => DRAW_SPEC[t] || DRAW_SPEC._default };');
// DRAW_TOOLS only supplies each tool's category; take it from the page's own table.
const toolCat = {};
for (const m of PAGE.matchAll(/\{ id:'([a-z]+)', name:'[^']*', groups:\[([\s\S]*?)\n  \]\}/g)) {
  for (const t of m[2].matchAll(/\['([a-z0-9]+)',\s*\{/g)) toolCat[t[1]] = { cat: m[1] };
}
const { DRAW_SPEC, DRAW_CAT_COLOR, drawDefaultColor, FIB_COLORS } = env('#a78bfa', toolCat);
const drawSpecOf = (t) => DRAW_SPEC[t] || DRAW_SPEC._default;
const drawOptOf = new Function('drawSpecOf', 'DRAW_STYLE_DEFAULT', 'drawDefaultColor', fn('drawOptOf') + '\nreturn drawOptOf;')(
  drawSpecOf, { color: '#a78bfa', w: 1.5, dash: 0 }, drawDefaultColor);
const drawColourFields = new Function('drawSpecOf', fn('drawColourFields') + '\nreturn drawColourFields;')(drawSpecOf);

test('the colour button offers every colour the tool paints with', () => {
  // It wrote `color` on every tool. A fib has no `color` — its levels do — so the button
  // moved nothing at all on the whole fib family, on positions, and on channel fills.
  assert.deepStrictEqual(drawColourFields('fib').map((f) => f.k), ['c0', 'c236', 'c382', 'c50', 'c618', 'c786', 'c100']);
  assert.deepStrictEqual(drawColourFields('pos').map((f) => f.k), ['targetColor', 'stopColor', 'color']);
  assert.deepStrictEqual(drawColourFields('chan').map((f) => f.k), ['color', 'fillColor']);
  assert.deepStrictEqual(drawColourFields('l').map((f) => f.k), ['color'], 'a plain line still has just the one');
  const pop = fn('openColourPop');
  assert.match(pop, /if \(fields\.length < 2\)/, 'the one-colour case keeps its swatch grid');
  assert.match(pop, /fields\.map\(f =>[\s\S]*?drawOptOf\(d, f\.k\)/, 'the several-colour case lists them');
  assert.doesNotMatch(pop, /'style','color'/, "it still hard-writes `color`");
});

test('what the toolbar shows is what the painter uses', () => {
  // The swatch read the tool's spec, the ink read one shared violet: a channel showed
  // #2962ff and painted #a78bfa.
  const at = PAGE.indexOf('const col = d.color || ');
  assert.notStrictEqual(at, -1, 'the painter no longer resolves a colour the way it did');
  assert.match(PAGE.slice(at, at + 60), /const col = d\.color \|\| drawOptOf\(d, 'color'\);/);
  for (const t of ['l', 'chan', 'rect', 'fib', 'pos']) {
    const shown = drawOptOf({ t }, 'color');
    assert.ok(/^#[0-9a-f]{6}$/i.test(shown), t + ' has no resolvable colour: ' + shown);
  }
  assert.strictEqual(drawOptOf({ t: 'chan' }, 'color'), '#2962ff', 'a channel paints the blue its dialog shows');
  assert.strictEqual(drawOptOf({ t: 'chan', style: { color: '#ff0000' } }, 'color'), '#ff0000', 'an explicit colour still wins');
});

test('the family palette is alive: a line is not a pattern is not a fib', () => {
  // `d.color || _st.color || drawDefaultColor(d.t)` could never reach the third term,
  // because _st.color was always the shared violet — so all 51 tools painted violet.
  assert.strictEqual(drawOptOf({ t: 'l' }, 'color'), DRAW_CAT_COLOR.lines);
  assert.strictEqual(drawOptOf({ t: 'tri' }, 'color'), DRAW_CAT_COLOR.patterns);
  assert.strictEqual(drawOptOf({ t: 'fib' }, 'color'), DRAW_CAT_COLOR.fib, 'no colour field at all: the family answers');
  assert.strictEqual(drawOptOf({ t: 'pen' }, 'color'), DRAW_CAT_COLOR.brushes);
  // A tool that states its own colour keeps it.
  assert.strictEqual(drawOptOf({ t: 'h' }, 'color'), '#f5a623');
  assert.strictEqual(drawOptOf({ t: 'meas' }, 'color'), '#2962ff');
  assert.notStrictEqual(drawOptOf({ t: 'l' }, 'color'), '#a78bfa', 'the placeholder violet is gone from lines');
});

test("a position's entry line takes the colour its dialog offers", () => {
  // The field was labelled "Lines" and painted none of them: the entry line was hardcoded.
  assert.match(PAGE, /\[e0, drawOptOf\(d, 'color'\)\]/);
  assert.ok(!PAGE.includes("[e0, '#b3b9c5']"), 'the entry line is still hardcoded');
  assert.strictEqual(drawOptOf({ t: 'pos' }, 'color'), '#b3b9c5', 'and it defaults to the grey it always was');
  assert.strictEqual(drawSpecOf('pos').style.find((f) => f.k === 'color').label, 'Entry line and labels');
});

test('a drag holds its canvas by id, so a deck rebuild cannot collapse the shape', () => {
  // renderCards() replaces the canvas; a held element is detached, its rect reads all
  // zeros, every later move maps off-plot, and the release commits a point.
  const down = PAGE.slice(PAGE.indexOf('// Freehand brush: a drag collects a path'), PAGE.indexOf('document.addEventListener(\'pointermove\', e => {\n  if (!_penDrag)'));
  assert.match(down, /_penDrag = \{ tk: _canvasTicker\(canvas\), cid: canvas\.id,/, 'the gesture still holds the element');
  assert.doesNotMatch(down, /canvas,\s*tool: _drawTool/, 'the element is still captured in the gesture');
  const move = PAGE.slice(PAGE.indexOf("document.addEventListener('pointermove', e => {\n  if (!_penDrag)"), PAGE.indexOf("document.addEventListener('pointerup', () => {\n  if (!_penDrag)"));
  assert.match(move, /const cv = document\.getElementById\(_penDrag\.cid\); if \(!cv\) return;/, 'the move does not re-resolve the canvas');
  assert.match(move, /_drawAnchor\(cv,/);
  assert.match(move, /if \(!_repaintCanvas\(cv\)\) renderTicker\(_penDrag\.tk\);/, 'the move still rewrites the card DOM every frame');
  // and the repaint helper paints the canvas it is handed, not one looked up by ticker
  const rp = fn('_repaintCanvas');
  assert.match(rp, /renderChart\(canvas, d\.bars, d\.rMin, d\.rMax, chartType, chartTimeframe\); return true;/);
  assert.match(fn('_repaintChart'), /if \(!_repaintCanvas\(canvas\)\) _refreshTicker\(tk\);/);
});
