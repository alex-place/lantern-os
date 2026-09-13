'use strict';
/**
 * test/trader-header-pickers.test.js — the interval and chart-type pickers (operator, 2026-09-13).
 *
 * TradingView's toolbar: the favourite intervals inline with the current one lit, the rest
 * under a ▾ with a star to promote them; the same for the chart type. Both lists come from
 * tables, the favourites are validated against those tables, and the Draw button is gone
 * because the drawing tools live on the rail.
 *
 * Run: node --test apps/lantern-garage/test/trader-header-pickers.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');
const AUTH = read('routes', 'auth.js');

// The tables, evaluated as written.
const tables = new Function('TF_ALLOWED',
  PAGE.slice(PAGE.indexOf('const INTERVALS = ['), PAGE.indexOf('/* Favourites: a list of ids')) + '; return { INTERVALS, CHART_TYPES, DEFAULT_TF_FAVS, DEFAULT_TYPE_FAVS, normalizeType };')(
  ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1mo']);
const { INTERVALS, CHART_TYPES, DEFAULT_TF_FAVS, DEFAULT_TYPE_FAVS, normalizeType } = tables;

test('the toolbar carries the two pickers and no longer the selects or the Draw button', () => {
  const hgroup = PAGE.slice(PAGE.indexOf('<div class="hgroup" role="group"'), PAGE.indexOf('<!-- /hgroup -->'));
  assert.match(hgroup, /<div class="picker" id="tfPicker" role="group" aria-label="Candle interval">/);
  assert.match(hgroup, /<div class="picker" id="typePicker" role="group" aria-label="Chart type">/);
  assert.match(hgroup, /id="indicatorsToggle"/);
  assert.match(hgroup, /id="chartSettingsBtn"/);
  for (const gone of ['id="chartTfSelect"', 'id="chartTypeSelect"', 'id="drawToggle"', 'toggleDrawMenu(this)']) {
    assert.ok(!hgroup.includes(gone), gone + ' is still on the toolbar');
  }
  // The drawing tools are on the rail; the rail's per-category "more" buttons open the catalogue.
  assert.match(PAGE, /class="dr-more"/);
  // Nothing else still reaches for the removed button by id.
  assert.ok(!PAGE.includes("{sel:'#drawToggle'"), 'the hamburger still picks the Draw button');
  assert.ok(!PAGE.includes("{sel:'#chartTypeSelect'"), 'the hamburger still picks the chart-type select');
});

test('the interval table is the allow-list, grouped the way TradingView groups it', () => {
  assert.deepStrictEqual(INTERVALS.map((i) => i.id), ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1mo']);
  assert.match(PAGE, /const TF_ALLOWED = \['1m','5m','15m','30m','1h','2h','4h','1d','1w','1mo'\];/);
  assert.deepStrictEqual([...new Set(INTERVALS.map((i) => i.group))], ['Minutes', 'Hours', 'Days']);
  assert.deepStrictEqual(INTERVALS.filter((i) => i.group === 'Days').map((i) => i.label), ['D', 'W', 'M']);
  for (const id of DEFAULT_TF_FAVS) assert.ok(INTERVALS.some((i) => i.id === id), 'default favourite ' + id + ' is not an interval');
});

test('every chart type in the table is one the renderer draws', () => {
  assert.deepStrictEqual(CHART_TYPES.map((t) => t.id), ['bar', 'candle', 'hollow', 'line', 'area', 'heikin']);
  for (const t of CHART_TYPES) {
    assert.ok(t.name && t.hint && t.icon.startsWith('<svg'), t.id + ' is missing a name, hint or icon');
  }
  // The family split in renderChart, and each type's own branch.
  assert.match(PAGE, /const _ohlcType = \(type==='candle' \|\| type==='hollow' \|\| type==='bar' \|\| type==='heikin'\);/);
  assert.match(PAGE, /const _src = type==='heikin' \? _heikinAshi\(bars\) : bars;/);
  assert.match(PAGE, /if\(type==='bar'\)\{/);
  assert.match(PAGE, /const _hollowUp = type==='hollow' && up;/);
  assert.match(PAGE, /if\(_drawBody && !_hollowUp\)\{/, 'a hollow up candle must never be filled');
  assert.match(PAGE, /if\(type==='area' \|\| _cs\('line\.area'\) === true\)\{/);
  assert.match(PAGE, /last\.close >= \(_ohlcType \? last\.open : bars\[0\]\.close\)/, 'the live dot still thinks only candles have an open');
  for (const id of DEFAULT_TYPE_FAVS) assert.ok(CHART_TYPES.some((t) => t.id === id), 'default favourite ' + id + ' is not a chart type');
});

test('an unknown saved chart type draws as candles, not as nothing', () => {
  assert.strictEqual(normalizeType('hollow'), 'hollow');
  assert.strictEqual(normalizeType('renko'), 'candle');
  assert.strictEqual(normalizeType(undefined), 'candle');
  assert.match(PAGE, /chartType = normalizeType\(chartType\);/, 'the restored value is never validated');
  assert.match(PAGE, /function changeChartType\(type\)\{\s*chartType = normalizeType\(type\);/);
});

test('Heikin Ashi is the standard definition', () => {
  const src = PAGE.slice(PAGE.indexOf('function _heikinAshi(bars){'), PAGE.indexOf('\n}\n', PAGE.indexOf('function _heikinAshi(bars){')) + 3);
  const ha = new Function(src + '; return _heikinAshi;')();
  const bars = [
    { open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { open: 11, high: 14, low: 10, close: 13, volume: 2 },
    { open: 13, high: 13, low: 8, close: 9, volume: 3 },
  ];
  const out = ha(bars);
  // First bar: open is the midpoint of open/close, close the mean of the four prices.
  assert.strictEqual(out[0].open, 10.5);
  assert.strictEqual(out[0].close, 10.5);
  // Second: open is the midpoint of the previous averaged bar.
  assert.strictEqual(out[1].open, 10.5);
  assert.strictEqual(out[1].close, 12);
  assert.strictEqual(out[1].high, 14);
  // Third: the low takes the averaged open/close into account when they fall below.
  assert.strictEqual(out[2].open, 11.25);
  assert.strictEqual(out[2].close, 10.75);
  assert.strictEqual(out[2].low, 8);
  assert.strictEqual(out[2].volume, 3, 'volume and the rest of the bar ride along');
  assert.notStrictEqual(out[0], bars[0], 'the source bars are not mutated');
});

test('favourites are validated against the tables, and fall back to the defaults', () => {
  const src = PAGE.slice(PAGE.indexOf('function _loadFavs(key, def, allowed){'), PAGE.indexOf('let tfFavs = _loadFavs('));
  const load = (stored) => new Function('localStorage', src + '; return _loadFavs;')({ getItem: () => stored })('k', ['1m', '5m'], ['1m', '5m', '1h']);
  assert.deepStrictEqual(load(null), ['1m', '5m']);
  assert.deepStrictEqual(load('["1h","5m","renko"]'), ['1h', '5m'], 'an id the table does not know cannot become a chip');
  assert.deepStrictEqual(load('not json'), ['1m', '5m']);
  assert.deepStrictEqual(load('"1h"'), ['1m', '5m'], 'not a list: the defaults');
});

test('the chips are the favourites in table order, plus the current one if it is not a favourite', () => {
  assert.match(PAGE, /INTERVALS\.filter\(i=> tfFavs\.indexOf\(i\.id\) !== -1 \|\| i\.id === chartTimeframe\)/);
  assert.match(PAGE, /CHART_TYPES\.filter\(t=> typeFavs\.indexOf\(t\.id\) !== -1 \|\| t\.id === chartType\)/);
  assert.match(PAGE, /class="chart-ctrl tf-chip' \+ \(on \? ' on' : ''\) \+ '" aria-pressed="' \+ on \+ '"/);
  // A star toggles a favourite and re-renders both the chips and the open menu.
  assert.match(PAGE, /function toggleTfFav\(id\)\{[\s\S]*?_saveFavs\(\); renderTfPicker\(\); _refreshPickMenu\('tf'\);/);
  assert.match(PAGE, /function toggleTypeFav\(id\)\{[\s\S]*?_saveFavs\(\); renderTypePicker\(\); _refreshPickMenu\('type'\);/);
  // The menu's click-away uses the helper that survives a row re-rendering itself (#3604).
  assert.match(PAGE, /if\(_clickInside\(m, e\)\) return;\s*\/\/ a star re-renders/);
});

test('the favourites follow the account, the way the indicators do', () => {
  assert.match(PAGE, /headerFavs: \{ tf: tfFavs, type: typeFavs \}/);
  assert.match(PAGE, /function adoptHeaderFavs\(obj\)\{/);
  assert.match(PAGE, /adoptHeaderFavs\(e\.detail && e\.detail\.headerFavs\)/);
  assert.match(AUTH, /info\.headerFavs = \{ tf: ids\(hf\.tf\), type: ids\(hf\.type\) \};/);
  assert.match(AUTH, /\.slice\(0, 12\)/, 'the lists are not capped on the way out');
});
