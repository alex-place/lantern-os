'use strict';
/**
 * test/trader-draw-tools.test.js — the tools that are not shapes (2026-09-15).
 *
 * Swept all 47 drawing tools through the real click path. Three came back broken: the
 * eraser committed an invisible {t:'eraser'} instead of deleting anything, the highlighter
 * could not be drawn at all, and a regression trend's handles floated off the drawing.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-tools.test.js
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
// The catalogue, as the page derives it.
const catStart = PAGE.indexOf('const DRAW_CATS = [');
const catEnd = PAGE.indexOf('\n})();', PAGE.indexOf('const DRAW_TOOLS = (() => {', catStart)) + 6;
const DRAW_TOOLS = new Function('ico', PAGE.slice(catStart, catEnd) + '\nreturn DRAW_TOOLS;')(() => '');
const isBrush = new Function('DRAW_TOOLS', fn('_isBrush') + '\nreturn _isBrush;')(DRAW_TOOLS);

test('the click path deletes with the eraser and never commits a tool that does not draw', () => {
  const click = PAGE.slice(PAGE.indexOf("const spec = DRAW_TOOLS[_drawTool]; if (!spec) return;"), PAGE.indexOf('_commitDrawing(tk, obj);'));
  assert.match(click, /if \(spec\.erase\) \{[\s\S]*?_deleteNearestDrawing\(tk, a\.data, a\.xPx, a\.yPx, a\.pw, a\.ph\)[\s\S]*?return;\s*\}/,
    'the eraser still falls through to the anchor path');
  assert.match(click, /if \(spec\.cursor\) \{ setDrawTool\(''\); return; \}/, 'an armed cursor could still commit a shape');
  // both branches must sit BEFORE anchors are pushed
  assert.ok(click.indexOf('spec.erase') < click.indexOf('_drawPending.pts.push'), 'the erase branch runs after an anchor is taken');
  // the eraser is a real tool with erase:true, and it is not a cursor
  assert.strictEqual(DRAW_TOOLS.eraser.erase, true);
  assert.ok(!DRAW_TOOLS.eraser.cursor, 'the eraser is not a cursor — pickDrawTool arms it');
  assert.match(PAGE, /setDrawTool\(t\.cursor \? '' : id\)/, 'pickDrawTool no longer arms by category');
});

test('a brush is whatever the catalogue marks as one, not the string "pen"', () => {
  assert.deepStrictEqual(Object.keys(DRAW_TOOLS).filter(isBrush).sort(), ['hl', 'pen']);
  assert.strictEqual(DRAW_TOOLS.hl.drag, true, 'the highlighter is declared a drag tool');
  assert.strictEqual(DRAW_TOOLS.hl.pts, 0, 'and takes no fixed number of anchors');
  // no path may test the id any more
  for (const bad of [
    "_drawTool !== 'pen'", "_drawTool === 'pen'", "_penDrag.tool === 'pen'", "_penDrag.tool !== 'pen'",
    "tool === 'pen'", "d.t === 'pen'", "sd.t === 'pen'",
  ]) assert.ok(!PAGE.includes(bad), 'a brush path still hardcodes the pen: ' + bad);
  assert.match(PAGE, /if \(!_isBrush\(_drawTool\) && !\(_spec && _spec\.pts === 2\)\) return;/, 'the drag gesture');
  assert.match(PAGE, /if \(_isBrush\(tool\)\) \{[\s\S]*?_commitDrawing\(tk, pane \? \{ t: tool, pts, pane \} : \{ t: tool, pts \}\);/, 'the commit');
});

test('a brush commits its own kind, and never a one-point stroke', () => {
  const up = PAGE.slice(PAGE.indexOf("document.addEventListener('pointerup', () => {\n  if (!_penDrag) return;"), PAGE.indexOf("/* -- Selecting and editing a placed drawing"));
  assert.match(up, /if \(pts\.length > 1\) _commitDrawing/, 'a single point can still commit');
  assert.doesNotMatch(up, /t: 'pen'/, 'the commit still hardcodes the pen');
  // the renderer needs two points for either brush, which is what made the one-point
  // highlighter invisible rather than merely small
  assert.match(PAGE, /case 'pen': \{\n\s*if \(P\.length < 2\) break;/);
  assert.match(PAGE, /case 'hl': \{[\s\S]{0,80}?\n\s*if \(P\.length < 2\) break;/);
});

test("a regression trend's handles sit on the line it draws, not on the anchors", () => {
  const src = fn('_drawingAnchors');
  assert.match(src, /if \(d\.t === 'regr' && pts\.length >= 2\) \{/);
  assert.match(src, /_regrBand\(data\.bars, slotW,/);
  // Run it: a fit whose price is nowhere near the anchors still puts the handles on the fit.
  const bars = [];
  let t = Date.UTC(2026, 8, 14, 13, 30);
  for (let i = 0; i < 60; i++, t += 5 * 60000) bars.push({ timestamp: new Date(t).toISOString(), close: 100 });
  const data = { bars, rMin: 0, rMax: 200 };
  const PW = 500, PH = 300;                                    // 60 bars + 25 margin slots -> slotW 500/85
  const anchors = new Function('_drawings', '_slotsFor', '_paneMapper', '_isBrush',
    fn('_drawTimeMap') + fn('_regrBand') + fn('_drawingAnchors') + '\nreturn _drawingAnchors;')(
    { SPY: [{ t: 'regr', pts: [{ ts: +new Date(bars[5].timestamp), price: 190 }, { ts: +new Date(bars[40].timestamp), price: 180 }] }] },
    (n) => n + 25, () => null, () => false)('SPY', data, 0, PW, PH);
  assert.strictEqual(anchors.length, 2);
  // every bar closes at 100, so the fit is the flat line at 100 -> y = (200-100)/200*300
  for (const a of anchors) assert.ok(Math.abs(a.y - 150) < 0.5, 'a handle is off the fitted line: y=' + a.y);
  assert.ok(anchors[0].x < anchors[1].x, 'left handle first');
  // and the handles still carry the anchors they move
  assert.strictEqual(anchors[0].price, 190);
  assert.strictEqual(anchors[1].price, 180);
});
