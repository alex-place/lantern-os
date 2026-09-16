'use strict';
/**
 * test/trader-ind-panes.test.js — indicator panes as their own charts (operator, 2026-09-13).
 *
 * A pane (MACD, RSI, …) has its own scale, zoomable on y alone (time follows the price
 * pane), takes drawings in its own units, and is resized by dragging the line above it;
 * and every colour of an indicator is the reader's, the MACD histogram's up and down
 * included.
 *
 * Run: node --test apps/lantern-garage/test/trader-ind-panes.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');

const slice = (from, to, after) => { const i = PAGE.indexOf(from, after || 0); assert.ok(i !== -1, 'missing: ' + from); const j = PAGE.indexOf(to, i); assert.ok(j !== -1, 'missing end: ' + to); return PAGE.slice(i, j); };

// The layout, the mapper, the zoom and the resize, evaluated as written over a stub
// indicator list and a stub crosshair record.
function paneCode(panes, crossData) {
  const src = slice('const PANE_MIN = 34;', 'const _ladderSig = {};');
  return new Function('indPanes', '_crossData',
    src + '; return { PANE_MIN, _paneLayout, _paneMapper, _paneKeyAt, _zoomPaneY, _paneSizeDrag };')(() => panes, crossData || {});
}

test('the pane layout: defaults, remembered shares, the price pane\'s quarter, and panes that do not fit', () => {
  const none = paneCode([])._paneLayout(400);
  assert.deepStrictEqual(none, { panes: [], paneN: 0, paneH: 0, panesH: 0, tops: [], hs: [], priceH: 400 });
  // Two panes, no sizes: 78px each (half the plot would allow 100, the cap is 78).
  const two = paneCode([{ id: 'rsi' }, { id: 'macd' }])._paneLayout(400);
  assert.deepStrictEqual(two.hs, [78, 78]);
  assert.deepStrictEqual(two.tops, [244, 322]);
  assert.strictEqual(two.priceH, 244);
  assert.strictEqual(two.panesH, 156);
  assert.strictEqual(two.paneN, 2);
  // A remembered share is honoured: 0.4 of a 400px plot is 160px.
  const sized = paneCode([{ id: 'macd', paneFrac: 0.4 }, { id: 'rsi' }])._paneLayout(400);
  assert.deepStrictEqual(sized.hs, [160, 78]);
  assert.strictEqual(sized.priceH, 162);
  // Three panes each asking for half: scaled together to the 75% cap, the price pane keeps a quarter.
  const greedy = paneCode([{ id: 'a', paneFrac: 0.5 }, { id: 'b', paneFrac: 0.5 }, { id: 'c', paneFrac: 0.5 }])._paneLayout(400);
  assert.ok(greedy.panesH <= 300 && greedy.priceH >= 100, 'the price pane lost its quarter: ' + JSON.stringify(greedy));
  assert.strictEqual(greedy.paneN, 3);
  // A plot too short for three minimum panes drops the last, never squeezes below 34px.
  const short = paneCode([{ id: 'a' }, { id: 'b' }, { id: 'c' }])._paneLayout(100);
  assert.strictEqual(short.paneN, 2);
  assert.ok(short.hs.every((h) => h >= 34));
  assert.ok(short.panesH <= 75);
  assert.strictEqual(short.tops.length, 2);
});

test('the mapper reads a pane by key or by the y under the cursor, both ways round', () => {
  const data = { panes: [{ key: 'macd', top: 244, h: 78, lo: -2, hi: 2 }, { key: 'rsi', top: 322, h: 78, lo: 0, hi: 100 }] };
  const { _paneMapper } = paneCode([], data);
  const m = _paneMapper(data, 'macd');
  assert.strictEqual(m.key, 'macd');
  assert.strictEqual(m.yOf(2), 244);
  assert.strictEqual(m.yOf(-2), 322);
  assert.strictEqual(m.yOf(0), 283);
  assert.ok(Math.abs(m.valueAt(m.yOf(1.25)) - 1.25) < 1e-9, 'y-of-value and value-of-y are inverses');
  const byY = _paneMapper(data, null, 350);
  assert.strictEqual(byY.key, 'rsi');
  assert.strictEqual(_paneMapper(data, 'atr'), null, 'a pane not on the chart is null, not a throw');
  assert.strictEqual(_paneMapper(data, null, 100), null, 'the price pane is not a pane');
  assert.strictEqual(_paneMapper(null, 'macd'), null);
});

test('zooming a pane scales about its middle, from the auto range until the reader owns it', () => {
  const data = { panes: [{ key: 'macd', top: 244, h: 78, lo: -2, hi: 2 }] };
  const { _zoomPaneY, _paneKeyAt } = paneCode([{ id: 'macd' }], { 'chart-SPY': data });
  const view = {};
  _zoomPaneY(view, { id: 'chart-SPY' }, 'macd', 2);
  assert.deepStrictEqual(view.paneY.macd, { min: -4, max: 4 });
  _zoomPaneY(view, { id: 'chart-SPY' }, 'macd', 0.5);
  assert.deepStrictEqual(view.paneY.macd, { min: -2, max: 2 });
  _zoomPaneY(view, { id: 'chart-SPY' }, 'atr', 2);
  assert.strictEqual(view.paneY.atr, undefined, 'a pane the chart has not painted cannot be zoomed');
  // Which pane the gutter y is beside, from the live layout.
  assert.strictEqual(_paneKeyAt({ id: 'chart-SPY' }, 400, 350), 'macd');
  assert.strictEqual(_paneKeyAt({ id: 'chart-SPY' }, 400, 100), null);
});

test('dragging the line above a pane resizes it, as a share of the plot, and neighbours trade height', () => {
  const panes = [{ id: 'macd' }, { id: 'rsi' }];
  const { _paneLayout, _paneSizeDrag, PANE_MIN } = paneCode(panes);
  const pl = _paneLayout(400);                         // [78, 78] under a 244px price pane
  // The first line, dragged up by 60px: the first pane grows to 138 (0.345 of the plot).
  _paneSizeDrag({ pl, sepIdx: 0, ph: 400 }, pl.tops[0] - 60);
  assert.ok(Math.abs(panes[0].paneFrac - 138 / 400) < 1e-9, String(panes[0].paneFrac));
  assert.strictEqual(panes[1].paneFrac, undefined, 'the second pane was not touched');
  // Dragged far past the top: the price pane keeps its quarter.
  _paneSizeDrag({ pl, sepIdx: 0, ph: 400 }, 0);
  assert.ok(Math.abs(panes[0].paneFrac - (300 - 78) / 400) < 1e-9, String(panes[0].paneFrac));
  // The line between the two: they trade, the pair's total unchanged, neither under the minimum.
  delete panes[0].paneFrac;
  const pl2 = _paneLayout(400);
  _paneSizeDrag({ pl: pl2, sepIdx: 1, ph: 400 }, pl2.tops[1] + 30);
  assert.ok(Math.abs(panes[0].paneFrac * 400 - 108) < 1e-6 && Math.abs(panes[1].paneFrac * 400 - 48) < 1e-6, JSON.stringify(panes));
  _paneSizeDrag({ pl: pl2, sepIdx: 1, ph: 400 }, 1000);
  assert.ok(Math.abs(panes[1].paneFrac * 400 - PANE_MIN) < 1e-6, 'the lower pane went under the minimum');
  // The next layout honours what the drag wrote.
  const pl3 = _paneLayout(400);
  assert.deepStrictEqual(pl3.hs, [Math.round(400 * panes[0].paneFrac), Math.round(400 * panes[1].paneFrac)]);
});

test('the renderer: the reader\'s scale, the recorded scale, the pane\'s drawings, the histogram colours', () => {
  assert.match(PAGE, /const \{ panes: _panes, paneN: _paneN, tops: _paneTops, hs: _paneHs, priceH \} = _paneLayout\(ph\);/);
  assert.match(PAGE, /_crossData\[canvas\.id\] = \{ bars, rMin, rMax, panes: \[\] \};/);
  assert.match(PAGE, /const _man = _paneMan\[cfg\.id\];\s*if\(_man && Number\.isFinite\(_man\.min\) && Number\.isFinite\(_man\.max\) && _man\.max > _man\.min\)\{ lo=_man\.min; hi=_man\.max; \}/);
  assert.match(PAGE, /_crossData\[canvas\.id\]\.panes\.push\(\{ key: cfg\.id, top, h: _hp, lo, hi \}\);/);
  assert.match(PAGE, /for\(const d of _drawList\)\{ if\(d\.hidden \|\| d\.pane !== cfg\.id\) continue; _drawOne\(d, false, yOf\); \}/);
  assert.match(PAGE, /for \(const d of list\) \{ if \(d\.hidden \|\| d\.pane\) continue; drawOne\(d, false\); \}/);
  assert.match(PAGE, /const drawOne = \(d, ghost, yMap\) => \{\s*_yMap = yMap \|\| y;/);
  assert.match(PAGE, /ctx\.fillStyle=_chartRgba\(v>=0 \? \(out\.histUp \|\| CHART_CANDLE_UP\(\)\) : \(out\.histDown \|\| CHART_CANDLE_DOWN\(\)\), \.55\);/);
  assert.match(PAGE, /overlay\.style\.bottom = \(AXIS_H \+ _pl\.panesH\) \+ 'px';/);
  // Inside the painter no anchor reads the price scale directly any more.
  const painter = slice('const drawOne = (d, ghost, yMap) => {', '_drawOne = drawOne;');
  assert.ok(!/(?<![A-Za-z0-9_.])y\(/.test(painter), 'the painter still calls y() directly');
  assert.ok(/_yMap\(/.test(painter));
});

test('drawings: anchored in a pane\'s units, kept to one pane, hit-tested and dragged in that pane', () => {
  assert.match(PAGE, /const pane = yPx > ph \? _paneMapper\(data, null, yPx\) : null;\s*if \(yPx > ph && !pane\) return null;/);
  assert.match(PAGE, /return \{ data, pw, ph, xPx, yPx, ts, price: \+price\.toFixed\(4\), pane: pane \? pane\.key : null \};/);
  assert.match(PAGE, /_drawPending = \{ tk, t: _drawTool, pts: \[\], pane: a\.pane \|\| null \};/);
  assert.match(PAGE, /if \(_drawPending\.pts\.length && \(_drawPending\.pane \|\| null\) !== \(a\.pane \|\| null\)\) \{ renderTicker\(tk\); return; \}/);
  assert.match(PAGE, /if \(_drawPending\.pane\) obj\.pane = _drawPending\.pane;/);
  // Both commit paths carry the pane: the brush's (any brush -- the id used to be
  // hardcoded, which is why the highlighter could not be drawn) and the shape's.
  assert.strictEqual((PAGE.match(/_commitDrawing\(tk, pane \? \{ t: tool, pts, pane \} : \{ t: tool, pts \}\);/g) || []).length, 2);
  assert.match(PAGE, /if \(\(a2\.pane \|\| null\) !== \(_drawPending\.pane \|\| null\)\) return;/);
  // Hit-testing and the handles use the drawing's own scale; a drawing whose pane is off the chart is untouchable.
  assert.strictEqual((PAGE.match(/const pm = d\.pane \? _paneMapper\(data, d\.pane\) : null;/g) || []).length, 2);
  assert.match(PAGE, /if \(d\.pane && !pm\) return;\s*\/\/ its pane is not on the chart right now/);
  assert.match(PAGE, /if \(d\.pane && !pm\) return \[\];/);
  assert.match(PAGE, /valueAt: \(py, d\) => \{ const pm = d && d\.pane \? _paneMapper\(data, d\.pane\) : null;/);
  assert.match(PAGE, /d\.pts\[idx\] = \{ ts: g\.tsAt\(x\), price: g\.valueAt\(y, d\) \};/);
  assert.match(PAGE, /const dpr = g\.valueAt\(y, d\) - g\.valueAt\(_dragDraw\.y0, d\);/);
  // The selection geometry maps against the price pane's height, not the plot's.
  assert.match(PAGE, /ph = _paneLayout\(Math\.max\(0, canvas\.clientHeight - AXIS_H\)\)\.priceH;\s*const rng = data\.rMax - data\.rMin; if \(rng <= 0\) return null;/);
});

test('the mouse: the line above a pane resizes, its gutter zooms it, its body pans it, double-click resets it', () => {
  assert.match(PAGE, /if\(_sepIdx >= 0\) mode = 'paneSize';\s*else if\(x >= w-AXIS_W\) mode = paneKey \? 'paneZoomY' : 'zoomY';/);
  assert.match(PAGE, /if\(drag\.mode === 'paneSize'\)\{\s*_paneSizeDrag\(drag, e\.clientY - drag\.rectTop\);/);
  assert.match(PAGE, /if\(drag\.mode === 'paneZoomY'\)\{/);
  assert.match(PAGE, /if\(drag\.paneKey\)\{[\s\S]*?if\(drag\.paneRange && drag\.paneH > 0\)\{/);
  assert.match(PAGE, /const delta = \(dy\/drag\.pricePh\)\*rng;/, 'the price pan still measures against the whole plot');
  assert.match(PAGE, /if\(drag\.mode === 'paneSize'\)\{ saveIndicators\(\); _indRerender\(\); \}/);
  assert.match(PAGE, /ladder\.style\.cursor = _sepHover \? 'row-resize' :/);
  assert.match(PAGE, /const _pk = _paneKeyAt\(canvas, h - AXIS_H, y\);\s*if\(_pk\)\{ _zoomPaneY\(view, canvas, _pk, factor\); renderTicker\(dataTicker\); return; \}/);
  assert.match(PAGE, /const _pkd = _paneKeyAt\(canvas, ph, y\);\s*if\(x > pw && _pkd\)\{[\s\S]*?if\(view\.paneY\) delete view\.paneY\[_pkd\];/);
  // The crosshair reads the pane's value below the price pane.
  assert.match(PAGE, /const _pn = \(data && y > ph\) \? _paneMapper\(data, null, y\) : null;/);
  assert.match(PAGE, /const price = _pn \? _pn\.valueAt\(y\) : data\.rMax - \(y\/ph\)\*\(data\.rMax - data\.rMin\);/);
});

test('every colour of an indicator is the reader\'s: each plot, and the histogram\'s up and down', () => {
  const names = new Function(slice('const _PLOT_NAMES = {', '\n};') + '\n}; return _PLOT_NAMES;')();
  const defs = new Function(slice('const IND_DEFS = {', '\n};') + '\n}; return IND_DEFS;')();
  for (const k of Object.keys(names)) assert.ok(defs[k], k + ' is not an indicator');
  assert.deepStrictEqual(names.macd, ['MACD', 'Signal']);
  assert.deepStrictEqual(names.adx, ['ADX', '+DI', '−DI']);
  // The wrapper applies a third colour and the histogram colours over what the case built.
  const wrap = slice('const _indComputeRaw = indCompute;', '/** Short label for the legend');
  const raw = () => ({ series: [{ values: [], color: '#111111' }, { values: [], color: '#222222' }, { values: [], color: '#333333' }], hist: [1, -1] });
  const indCompute = new Function('indCompute', 'indLineColour', wrap.replace('const _indComputeRaw = indCompute;', 'const _indComputeRaw = indCompute;') + '; return indCompute;')(raw, (h) => h);
  const out = indCompute({ id: 'macd', color3: '#abcdef', histUp: '#00ff00', histDown: '#ff0000' }, []);
  assert.strictEqual(out.series[2].color, '#abcdef');
  assert.strictEqual(out.histUp, '#00ff00');
  assert.strictEqual(out.histDown, '#ff0000');
  const plain = indCompute({ id: 'macd' }, []);
  assert.strictEqual(plain.series[2].color, '#333333');
  assert.strictEqual(plain.histUp, null, 'unset means the palette');
  // The Style tab: a swatch per plot, the histogram's two, and a way back.
  const style = slice("const _out = indCompute(cfg, [{open:1,high:1,low:1,close:1,volume:1}]) || { series:[] };", "h += '<div class=\"dr-fly-foot\">");
  assert.match(style, /for\(let k=0; k<Math\.min\(3, _out\.series\.length\); k\+\+\)\{/);
  assert.match(style, /Histogram up/);
  assert.match(style, /Histogram down/);
  assert.match(style, /indSetStyle\('\+idx\+',\\'histDown\\',this\.value\)/);
  assert.match(style, /onclick="indResetStyle\('\+idx\+'\)">Reset colours<\/button>/);
  assert.match(PAGE, /if\(key === 'color2' \|\| key === 'color3' \|\| key === 'histUp' \|\| key === 'histDown'\)\{ if\(v\) cfg\[key\] = String\(v\); else delete cfg\[key\]; \}/);
  assert.match(PAGE, /function indResetStyle\(i\)\{[\s\S]*?for\(const k of \['color2','color3','histUp','histDown','width','dash'\]\) delete cfg\[k\];/);
  // The colour input only takes #rrggbb.
  const hex6 = new Function(slice('function _hex6(v){', '\n}\n') + '\n}; return _hex6;')();
  assert.strictEqual(hex6('#ABCDEF'), '#abcdef');
  assert.strictEqual(hex6('#abc'), '#aabbcc');
  assert.strictEqual(hex6('rgb(1,2,3)'), '#888888');
  assert.strictEqual(hex6(undefined), '#888888');
});
