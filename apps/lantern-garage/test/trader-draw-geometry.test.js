'use strict';
/**
 * test/trader-draw-geometry.test.js — drawings stay on their bars and are clickable
 * across what they draw (founder, 2026-09-14).
 *
 * 1. _drawTimeMap: anchors map to pixels through the BAR INDEX. The old map spread the
 *    window's clock time evenly over its bars, so a weekend inside the window pushed every
 *    anchor sideways by dozens of bars -- differently each time the window moved.
 * 2. _hitDrawing: a shape's fill, a channel's band, a fib's intermediate levels and a
 *    label's letters are hits, not just strokes and anchor points.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-geometry.test.js
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
const MIN = 60000;
// Five-minute bars: Friday 15:30-16:00, then Monday 09:30-10:30 -- a weekend inside.
function weekBars() {
  const bars = [];
  let t = Date.UTC(2026, 8, 11, 19, 30);                       // Fri 15:30 ET
  for (let i = 0; i < 7; i++, t += 5 * MIN) bars.push({ timestamp: new Date(t).toISOString(), close: 100 + i });
  t = Date.UTC(2026, 8, 14, 13, 30);                           // Mon 09:30 ET
  for (let i = 0; i < 13; i++, t += 5 * MIN) bars.push({ timestamp: new Date(t).toISOString(), close: 110 + i });
  return bars;
}
const timeMap = new Function(fn('_drawTimeMap') + '\nreturn _drawTimeMap;')();

test('every bar maps to its own slot, weekend or not', () => {
  const bars = weekBars(), slotW = 4, tm = timeMap(bars, slotW);
  assert.strictEqual(tm.step, 5 * MIN, 'the typical gap is five minutes, not the weekend');
  bars.forEach((b, i) => assert.ok(Math.abs(tm.xOf(+new Date(b.timestamp)) - (i * slotW + slotW/2)) < 1e-6, 'bar ' + i));
  // The old map put Monday's first bar a third of the way across a window that is 65% Monday.
  const ts0 = +new Date(bars[0].timestamp), ts1 = +new Date(bars[19].timestamp);
  const oldX = ((+new Date(bars[7].timestamp) - ts0) / (ts1 - ts0)) * (19 * slotW) + slotW/2;
  assert.ok(Math.abs(oldX - (7 * slotW + slotW/2)) > 5 * slotW, 'the old map was off by more than five bars here');
});

test('a click lands on a real moment and comes back to the same pixel', () => {
  const bars = weekBars(), slotW = 4, tm = timeMap(bars, slotW);
  for (const px of [2, 9, 26, 30, 50, 78]) assert.ok(Math.abs(tm.xOf(tm.tsAt(px)) - px) < 1e-6, 'px ' + px);
  // Inside the weekend gap: a moment on Saturday sits inside the one slot between Fri and Mon.
  const sat = Date.UTC(2026, 8, 12, 12, 0);
  const x = tm.xOf(sat);
  assert.ok(x > 6 * slotW + slotW/2 && x < 7 * slotW + slotW/2, 'Saturday sits between bar 6 and bar 7: ' + x);
});

test('beyond the loaded bars the map keeps the bars\' own pace', () => {
  const bars = weekBars(), slotW = 4, tm = timeMap(bars, slotW);
  const last = +new Date(bars[19].timestamp), first = +new Date(bars[0].timestamp);
  assert.ok(Math.abs(tm.xOf(last + 3 * 5 * MIN) - (22 * slotW + slotW/2)) < 1e-6, 'three bars past the end');
  assert.ok(Math.abs(tm.xOf(first - 2 * 5 * MIN) - (-2 * slotW + slotW/2)) < 1e-6, 'two bars before the start');
  assert.strictEqual(tm.tsAt(22 * slotW + slotW/2), last + 3 * 5 * MIN, 'a click in the right margin is a future bar');
  assert.strictEqual(timeMap([bars[0]], slotW).xOf(first), slotW/2, 'one bar sits in its slot');
});

test('a drag slides along the bars: ten bars to the right stays ten bars across the weekend', () => {
  const bars = weekBars(), slotW = 4, tm = timeMap(bars, slotW);
  const fri = +new Date(bars[2].timestamp);
  const moved = tm.shiftTs(fri, 10 * slotW);
  assert.strictEqual(moved, +new Date(bars[12].timestamp), 'bar 2 plus ten bars is bar 12');
  assert.strictEqual(tm.shiftTs(moved, -10 * slotW), fri, 'and back');
});

// ── the hit test, with the page's real function and a stand-in chart ─────────────────
function chart() {
  const bars = [];
  let t = Date.UTC(2026, 8, 14, 13, 30);
  for (let i = 0; i < 100; i++, t += 5 * MIN) bars.push({ timestamp: new Date(t).toISOString(), close: 150 + Math.sin(i / 7) * 10 });
  return { bars, rMin: 100, rMax: 200 };                       // pw 500 -> slotW 4 (100 bars + 25 margin slots), ph 300
}
const PW = 500, PH = 300;
const tsOfBar = (bars, i) => +new Date(bars[i].timestamp);
function hitter(drawings) {
  const src = fn('_drawTimeMap') + fn('_regrBand') + fn('_drawTextWidth').replace('let _measureCtx = null;', '') + fn('_hitDrawing');
  return new Function('_drawings', '_paneMapper', '_slotsFor', 'FIB_LEVELS', 'FIB_EXT', 'drawOptOf', 'document',
    'let _measureCtx = null;\n' + src + '\nreturn _hitDrawing;')(
    drawings, () => null, (n) => n + 25, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], [0, 0.618, 1, 1.618, 2.618], () => undefined, undefined);
}
const yOf = (p) => ((200 - p) / 100) * PH;
const xOfBar = (i) => i * 4 + 2;

test('a rectangle is a hit on its fill, and a line crossing it still wins on the line', () => {
  const data = chart(), b = data.bars;
  const rect = { t: 'rect', pts: [{ ts: tsOfBar(b, 10), price: 180 }, { ts: tsOfBar(b, 40), price: 150 }] };
  const line = { t: 'l', pts: [{ ts: tsOfBar(b, 5), price: 190 }, { ts: tsOfBar(b, 45), price: 140 }] };
  const hit = hitter({ SPY: [rect, line] });
  const inside = hit('SPY', data, xOfBar(35), yOf(175), PW, PH, 14);      // well inside the box, 26px off the line
  assert.ok(inside && inside.i === 0, 'the fill is a hit');
  assert.strictEqual(inside.dist, 14 * 0.75, 'an inside counts a little weaker than a stroke');
  // A point ON the line, inside the box: the line wins.
  const t = 0.5, lx = xOfBar(5) + t * (xOfBar(45) - xOfBar(5)), ly = yOf(190) + t * (yOf(140) - yOf(190));
  const onLine = hit('SPY', data, lx, ly, PW, PH, 14);
  assert.ok(onLine && onLine.i === 1, 'the line under the pointer wins over the box around it');
  assert.strictEqual(hit('SPY', data, xOfBar(90), yOf(105), PW, PH, 14), null, 'far away is nothing');
});

test('ellipse, triangle, channel and flat channel are hits on their fill; an ellipse\'s corner is not', () => {
  const data = chart(), b = data.bars;
  const ell = { t: 'ell', pts: [{ ts: tsOfBar(b, 10), price: 190 }, { ts: tsOfBar(b, 60), price: 150 }] };  // 200 x 120 px
  const tri = { t: 'tri', pts: [{ ts: tsOfBar(b, 70), price: 140 }, { ts: tsOfBar(b, 90), price: 140 }, { ts: tsOfBar(b, 80), price: 110 }] };
  const chan = { t: 'chan', pts: [{ ts: tsOfBar(b, 5), price: 130 }, { ts: tsOfBar(b, 60), price: 120 }, { ts: tsOfBar(b, 30), price: 110 }] };
  const flat = { t: 'flat', pts: [{ ts: tsOfBar(b, 62), price: 195 }, { ts: tsOfBar(b, 95), price: 185 }, { ts: tsOfBar(b, 95), price: 170 }] };
  const hit = hitter({ SPY: [ell, tri, chan, flat] });
  const centre = hit('SPY', data, (xOfBar(10) + xOfBar(60))/2, (yOf(190) + yOf(150))/2, PW, PH, 14);
  assert.ok(centre && centre.i === 0, 'the ellipse is a hit at its centre');
  assert.strictEqual(hit('SPY', data, xOfBar(11), yOf(189), PW, PH, 14), null, 'the bounding box corner outside the ellipse is not');
  const inTri = hit('SPY', data, xOfBar(80), yOf(130), PW, PH, 14);
  assert.ok(inTri && inTri.i === 1, 'inside the triangle');
  const inChan = hit('SPY', data, xOfBar(32), yOf(118), PW, PH, 14);
  assert.ok(inChan && inChan.i === 2, 'inside the channel band');
  const inFlat = hit('SPY', data, xOfBar(78), yOf(180), PW, PH, 14);
  assert.ok(inFlat && inFlat.i === 3, 'inside the flat channel');
});

test('a fib retracement is a hit on every level it draws, all the way to the right edge', () => {
  const data = chart(), b = data.bars;
  const fib = { t: 'fib', pts: [{ ts: tsOfBar(b, 10), price: 120 }, { ts: tsOfBar(b, 30), price: 180 }] };
  const hit = hitter({ SPY: [fib] });
  const y50 = yOf(120 + 60 * 0.5);
  const far = hit('SPY', data, PW - 6, y50, PW, PH, 14);
  assert.ok(far && far.i === 0, 'the 50% level near the right edge');
  const y382 = yOf(120 + 60 * 0.382);
  assert.ok(hit('SPY', data, xOfBar(50), y382, PW, PH, 14), 'the 38.2% level');
  assert.strictEqual(hit('SPY', data, xOfBar(3), y50, PW, PH, 14), null, 'left of where it starts is nothing');
});

test('a text label is a hit across its letters, not only at its anchor', () => {
  const data = chart(), b = data.bars;
  const text = { t: 'text', text: 'breakout retest here', pts: [{ ts: tsOfBar(b, 50), price: 160 }] };
  const note = { t: 'note', text: 'watch the open', pts: [{ ts: tsOfBar(b, 50), price: 120 }] };
  const hit = hitter({ SPY: [text, note] });
  const onLetters = hit('SPY', data, xOfBar(50) + 60, yOf(160), PW, PH, 14);   // 60px into the text
  assert.ok(onLetters && onLetters.i === 0 && onLetters.dist === 0, 'the letters are the drawing');
  const onNote = hit('SPY', data, xOfBar(50) + 40, yOf(120) + 4, PW, PH, 14);
  assert.ok(onNote && onNote.i === 1 && onNote.dist === 0, 'the note box is the drawing');
  assert.strictEqual(hit('SPY', data, xOfBar(50) + 60, yOf(160) + 40, PW, PH, 14), null, 'below the text is nothing');
});

test('the painter, the click, the handles and the drag all use the one map', () => {
  assert.doesNotMatch(PAGE, /\(ts - ts0\)\/\(ts1 - ts0\)/, 'no elapsed-time map left');
  assert.doesNotMatch(PAGE, /\(ts1 - ts0\)/, 'no elapsed-time inverse left');
  assert.match(PAGE, /const xOf = _drawTimeMap\(bars, slotW\)\.xOf;/, 'the painter');
  assert.match(PAGE, /const ts = _drawTimeMap\(data\.bars, slotW\)\.tsAt\(xPx\);/, 'the click');
  assert.match(PAGE, /tsAt: tm\.tsAt, shiftTs: tm\.shiftTs/, 'the drag geometry');
  assert.match(PAGE, /ts: g\.shiftTs\(pt\.ts, dx\)/, 'a body drag slides along the bars');
  assert.match(PAGE, /const band = _regrBand\(bars, slotW/, 'the regression band is shared with the hit test');
});
