'use strict';
/**
 * test/chart-settings.test.js — the trader's chart settings dialog (#3602).
 *
 * The module is a table of fields and the things derived from it. These tests hold the
 * table to its promises: every control in the dialog edits a real key, every key is
 * reachable from the dialog, storage keeps only what differs from the defaults, a bad
 * value can never reach the chart, and the account's copy corrects the device's without
 * a redraw when they already agree.
 *
 * Run: node --test apps/lantern-garage/test/chart-settings.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The module never touches the DOM at load, but storage is localStorage. A stub that
// behaves like the real one (strings in, strings out) is enough.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const CS = require('../public/js/chart-settings');

beforeEach(() => { store.clear(); CS._resetForTests(); });

// ── the table ────────────────────────────────────────────────────────────────

test('every control in the dialog edits a key that exists', () => {
  for (const tab of CS.TABS) for (const sec of tab.sections) for (const row of sec.rows) {
    for (const k of CS.rowKeys(row)) assert.ok(CS.FIELDS[k], tab.id + ' › ' + sec.title + ' › ' + row.label + ' edits unknown key ' + k);
    assert.ok(row.label, 'a row without a label in ' + tab.id);
  }
});

test('every key is reachable from the dialog — nothing is stored that cannot be changed', () => {
  const seen = new Set();
  for (const tab of CS.TABS) for (const sec of tab.sections) for (const row of sec.rows) for (const k of CS.rowKeys(row)) seen.add(k);
  const orphans = CS.KEYS.filter((k) => !seen.has(k));
  assert.deepStrictEqual(orphans, []);
});

test('the seven tabs TradingView has, in its order', () => {
  assert.deepStrictEqual(CS.TABS.map((t) => t.id), ['symbol', 'status', 'scales', 'canvas', 'trading', 'alerts', 'events']);
});

test('every colour is nullable and null by default — the theme and the palette win unless asked', () => {
  /* The candle colours follow the reader's gain/loss palette (#3592) and the grid follows
     the light/dark theme. A colour that DEFAULTED to a hex would silently override both
     for everyone the first time the dialog was opened. The three pre/post/alert accents
     are the exception on purpose: they have no theme token to follow. */
  const seeded = ['scales.preColor', 'scales.postColor'];
  for (const k of CS.KEYS) {
    if (CS.FIELDS[k].type !== 'color') continue;
    if (seeded.includes(k)) { assert.ok(CS.isHex(CS.DEFAULTS[k]), k); continue; }
    assert.strictEqual(CS.DEFAULTS[k], null, k + ' defaults to a fixed colour');
  }
});

test('the defaults ARE the chart as it draws today', () => {
  // A settings dialog must not change the chart for the reader who never opens it.
  assert.strictEqual(CS.DEFAULTS['candles.body'], true);
  assert.strictEqual(CS.DEFAULTS['candles.wick'], true);
  assert.strictEqual(CS.DEFAULTS['candles.border'], false);
  // Regular hours by default since the range buttons took TradingView's densities (2026-09-13).
  assert.strictEqual(CS.DEFAULTS['data.session'], 'regular');
  assert.strictEqual(CS.DEFAULTS['data.timezone'], 'exchange');
  assert.strictEqual(CS.DEFAULTS['canvas.bgMode'], 'theme');
  // The one deliberate exception: the right margin is on, TradingView's way (2026-09-13).
  assert.strictEqual(CS.DEFAULTS['canvas.marginRight'], 25);
  assert.strictEqual(CS.DEFAULTS['trading.buySell'], true);
  assert.strictEqual(CS.DEFAULTS['scales.lastPrice'], true);
  for (const k of ['canvas.watermark', 'scales.prevClose', 'scales.highLow', 'scales.countdown', 'scales.indLabels',
    'scales.prePost', 'events.sessionBreaks', 'alerts.lines', 'trading.executionMarks', 'status.ohlc']) {
    assert.strictEqual(CS.DEFAULTS[k], false, k + ' would appear on every chart uninvited');
  }
});

// ── validation ───────────────────────────────────────────────────────────────

test('normalise drops what it does not know and repairs what it cannot use', () => {
  const n = CS.normalise({
    'candles.bodyUp': 'green',            // not a hex
    'candles.bodyDown': '#ABCDEF',        // fine, and lower-cased
    'data.timezone': 'Mars/Olympus',      // not offered
    'canvas.marginTop': 900,              // clamped
    'canvas.axisFontSize': '12',          // a string that is a number
    'line.width': 2.26,                   // snapped to the step
    'status.ohlc': 'true',                // a string that is a boolean
    'trading.pnl': 'money',
    'nope.nothing': 1,
    __proto__: { 'candles.body': false },
  });
  assert.strictEqual(n['candles.bodyUp'], null);
  assert.strictEqual(n['candles.bodyDown'], '#abcdef');
  assert.strictEqual(n['data.timezone'], 'exchange');
  assert.strictEqual(n['canvas.marginTop'], 40);
  assert.strictEqual(n['canvas.axisFontSize'], 12);
  assert.strictEqual(n['line.width'], 2.5);
  assert.strictEqual(n['status.ohlc'], true);
  assert.strictEqual(n['trading.pnl'], 'money');
  assert.strictEqual(n['nope.nothing'], undefined);
  assert.strictEqual(n['candles.body'], true, 'an inherited key was read');
  assert.strictEqual(Object.keys(n).length, CS.KEYS.length);
});

test('normalise never throws', () => {
  for (const bad of [null, undefined, 42, 'x', [], () => {}, { 'candles.body': Symbol('s') }]) {
    assert.doesNotThrow(() => CS.normalise(bad));
    assert.deepStrictEqual(CS.normalise(bad), CS.DEFAULTS);
  }
});

test('an empty colour means "follow the theme" again', () => {
  CS.set('candles.wickUp', '#112233');
  assert.strictEqual(CS.get('candles.wickUp'), '#112233');
  assert.strictEqual(CS.set('candles.wickUp', ''), true);
  assert.strictEqual(CS.get('candles.wickUp'), null);
  assert.ok(CS.isDefault('candles.wickUp'));
});

// ── storage ──────────────────────────────────────────────────────────────────

test('only the difference from the defaults is stored', () => {
  CS.set('canvas.marginRight', 5);
  CS.set('candles.byPrevClose', true);
  const raw = JSON.parse(store.get(CS.STORAGE_KEY));
  assert.deepStrictEqual(raw, { 'canvas.marginRight': 5, 'candles.byPrevClose': true });
  CS.set('canvas.marginRight', 25);   // back to the default
  assert.deepStrictEqual(JSON.parse(store.get(CS.STORAGE_KEY)), { 'candles.byPrevClose': true });
  CS.set('candles.byPrevClose', false);
  assert.strictEqual(store.has(CS.STORAGE_KEY), false, 'all-default should leave nothing behind');
});

test('a changed default reaches everyone who never touched that key', () => {
  // The device holds a diff, so what it does NOT hold is the product's decision.
  store.set(CS.STORAGE_KEY, JSON.stringify({ 'line.width': 3 }));
  assert.strictEqual(CS.get('line.width'), 3);
  assert.strictEqual(CS.get('line.area'), CS.DEFAULTS['line.area']);
});

test('a corrupted device copy degrades to the defaults, not to a chart that will not draw', () => {
  store.set(CS.STORAGE_KEY, '{not json');
  assert.deepStrictEqual(CS.read(), CS.DEFAULTS);
  store.set(CS.STORAGE_KEY, JSON.stringify([1, 2, 3]));
  assert.deepStrictEqual(CS.read(), CS.DEFAULTS);
});

test('set reports whether anything changed, and rejects what it cannot use', () => {
  assert.strictEqual(CS.set('canvas.gridStyle', 'dashed'), true);
  assert.strictEqual(CS.set('canvas.gridStyle', 'dashed'), false, 'same value again');
  assert.strictEqual(CS.set('canvas.gridStyle', 'wavy'), false);
  assert.strictEqual(CS.get('canvas.gridStyle'), 'dashed');
  assert.strictEqual(CS.set('not.a.key', 1), false);
});

test('listeners hear which keys changed, and one bad listener does not silence the rest', () => {
  const heard = [];
  CS.onChange(() => { throw new Error('boom'); });
  const off = CS.onChange((keys) => heard.push(keys.slice()));
  CS.set('status.volume', true);
  assert.deepStrictEqual(heard, [['status.volume']]);
  off();
  CS.set('status.volume', false);
  assert.strictEqual(heard.length, 1);
});

test('reset returns every changed key and leaves the store empty', () => {
  CS.set('canvas.marginTop', 20);
  CS.set('trading.pnl', 'hidden');
  const changed = CS.reset();
  assert.deepStrictEqual(changed.sort(), ['canvas.marginTop', 'trading.pnl']);
  assert.deepStrictEqual(CS.state(), CS.DEFAULTS);
  assert.strictEqual(store.has(CS.STORAGE_KEY), false);
});

// ── the account ──────────────────────────────────────────────────────────────

test('adopt: the account corrects the device, and an equal copy is a no-op', () => {
  const heard = [];
  CS.onChange((keys) => heard.push(keys.slice()));
  CS.set('canvas.marginRight', 3);
  heard.length = 0;
  // The account says something different: it wins, and the device copy is updated.
  assert.deepStrictEqual(CS.adopt({ 'canvas.marginRight': 8, 'status.ohlc': true }).sort(), ['canvas.marginRight', 'status.ohlc']);
  assert.strictEqual(CS.get('canvas.marginRight'), 8);
  assert.deepStrictEqual(JSON.parse(store.get(CS.STORAGE_KEY)), { 'canvas.marginRight': 8, 'status.ohlc': true });
  assert.strictEqual(heard.length, 1);
  // The same again: nothing moves, nobody is told, no redraw.
  assert.deepStrictEqual(CS.adopt({ 'canvas.marginRight': 8, 'status.ohlc': true }), []);
  assert.strictEqual(heard.length, 1);
});

test('adopt ignores garbage and a hand-edited profile cannot smuggle a bad value', () => {
  assert.deepStrictEqual(CS.adopt(null), []);
  assert.deepStrictEqual(CS.adopt('x'), []);
  CS.adopt({ 'canvas.axisFontSize': 400, 'candles.bodyUp': 'javascript:alert(1)' });
  assert.strictEqual(CS.get('canvas.axisFontSize'), 15);
  assert.strictEqual(CS.get('candles.bodyUp'), null);
});

test('what travels to the account is the same diff the device stores', () => {
  CS.set('scales.dayOfWeek', true);
  CS.set('canvas.bgMode', 'solid');
  CS.set('canvas.bgColor', '#101010');
  assert.deepStrictEqual(CS.diff(CS.state()), { 'scales.dayOfWeek': true, 'canvas.bgMode': 'solid', 'canvas.bgColor': '#101010' });
});

// ── templates ────────────────────────────────────────────────────────────────

test('a template is a named diff: save, apply, delete', () => {
  CS.set('canvas.gridStyle', 'dotted');
  CS.set('candles.wick', false);
  assert.strictEqual(CS.saveTemplate('  Night desk  '), true);
  assert.deepStrictEqual(CS.templates(), { 'Night desk': { 'canvas.gridStyle': 'dotted', 'candles.wick': false } });
  CS.reset();
  assert.strictEqual(CS.get('candles.wick'), true);
  assert.deepStrictEqual(CS.applyTemplate('Night desk').sort(), ['candles.wick', 'canvas.gridStyle']);
  assert.strictEqual(CS.get('candles.wick'), false);
  assert.strictEqual(CS.applyTemplate('nope'), null);
  assert.strictEqual(CS.deleteTemplate('Night desk'), true);
  assert.deepStrictEqual(CS.templates(), {});
  assert.strictEqual(CS.deleteTemplate('Night desk'), false);
});

test('templates are bounded and a nameless one is refused', () => {
  assert.strictEqual(CS.saveTemplate(''), false);
  assert.strictEqual(CS.saveTemplate('   '), false);
  for (let i = 0; i < CS.MAX_TEMPLATES; i += 1) assert.strictEqual(CS.saveTemplate('t' + i), true);
  assert.strictEqual(CS.saveTemplate('one too many'), false);
  assert.strictEqual(CS.saveTemplate('t0'), true, 'overwriting an existing name is not a new template');
});

// ── the page ─────────────────────────────────────────────────────────────────

test('the trader page loads the module in <head>, after the palette it layers on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');
  const cs = src.indexOf('/js/chart-settings.js');
  const sp = src.indexOf('/js/signal-palette.js');
  assert.ok(cs > 0, 'the trader does not load chart-settings.js');
  assert.ok(cs < src.indexOf('</head>'), 'loaded after </head>: the first paint would ignore the settings');
  assert.ok(sp > 0 && sp < cs, 'the palette must be defined before the settings that default to it');
});
// ── the page reads every key ─────────────────────────────────────────────────

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');

test('every key in the table is read somewhere on the page — a switch wired to nothing cannot ship', () => {
  /* The whole point of the table: a control can only be added here if the renderer
     asks for it. This is the test that keeps the dialog honest. */
  const unread = CS.KEYS.filter((k) => !PAGE.includes("_cs('" + k + "')"));
  assert.deepStrictEqual(unread, []);
});

test('a switch is always compared against its NON-default value', () => {
  /* So a page whose module failed to load draws exactly as before the dialog existed:
     _cs() then returns undefined, and undefined has to fall on the default's side of
     every comparison. For a default-true key the literal in the comparison is `false`
     ("!== false" reads on, "=== false" reads off -- undefined is on either way); for a
     default-false key the literal is `true`. Comparing against the default itself is the
     bug: "=== true" on a default-true key turns the feature OFF when the module is missing. */
  const bad = [];
  for (const k of CS.KEYS) {
    if (CS.FIELDS[k].type !== 'check') continue;
    const uses = PAGE.match(new RegExp("_cs\\('" + k.replace('.', '\\.') + "'\\)\\s*(!==|===)\\s*(true|false)", 'g')) || [];
    for (const u of uses) {
      const literal = u.endsWith('true');
      if (literal === CS.DEFAULTS[k]) bad.push(k + ': ' + u);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('bars meet pixels in one place, and the right margin is part of it', () => {
  // Eight sites computed pw/n on their own; a right margin changes the slot width, so
  // any one of them left behind would have put the crosshair or a drawing on the wrong bar.
  assert.doesNotMatch(PAGE, /slotW = pw\s*\/\s*n;/, 'a bar-to-pixel mapping bypasses _slotsFor');
  assert.doesNotMatch(PAGE, /slotW = drag\.pw\/drag\.visibleBars;/, 'the pan mapping bypasses _slotsFor');
  assert.match(PAGE, /function _slotsFor\(n\)\{ const r = _cs\('canvas\.marginRight'\); const m = r == null \? 25 : Number\(r\) \|\| 0;/);
});

test('the overlay maps prices onto the PRICE pane, not the whole plot', () => {
  /* Since #3333 the sub-pane strip came off the bottom of the canvas, but the HTML overlay
     kept positioning by percent of its own full height: with an RSI strip on, the live
     price line, entry, stop and target all landed a strip's height too low. One layout
     function now, and the overlay's bottom edge follows it. */
  assert.match(PAGE, /function _paneLayout\(ph\)\{/);
  assert.match(PAGE, /const \{ panes: _panes, paneH: _paneH, paneN: _paneN, priceH \} = _paneLayout\(ph\);/, 'the renderer has its own copy of the pane maths');
  assert.match(PAGE, /overlay\.style\.bottom = \(AXIS_H \+ _pl\.paneN \* _pl\.paneH\) \+ 'px';/);
  assert.match(PAGE, /const pw = w - AXIS_W, ph = _paneLayout\(h - AXIS_H\)\.priceH;/, 'the crosshair still reads prices off the full plot');
});

test('the top-left column is one rule: badge and pills, then values, then legend rows', () => {
  assert.match(PAGE, /const _legendTop = \(\)=>/);
  assert.match(PAGE, /_legendRows\[canvas\.id\] = _lines\.map\(\(l, i\)=> \(\{ x:34, y:_lt \+ i\*_lh, h:_lh, i \}\)\);/);
  assert.match(PAGE, /\.chart-order-pills\{position:absolute;top:4px;left:36px;/, 'the pills sit on the timeframe badge again');
  assert.match(PAGE, /top:\$\{_legendTop\(\) - 16\}px/, 'the chart-values readout is not in the legend column');
});

test('the indicator editor no longer unfolds inside the dropdown; each indicator has a dialog', () => {
  assert.doesNotMatch(PAGE, /_indEditing/, 'the inline editor state is still there');
  assert.match(PAGE, /function openIndicatorSettings\(idx, ev, atX, atY\)\{/);
  assert.match(PAGE, /onclick="openIndicatorSettings\('\+idx\+',event\)"/, 'a menu row does not open the dialog');
  // The legend on the chart opens it too, and the pointer says so.
  assert.match(PAGE, /const rows = _legendRows\[canvas\.id\]; if\(!rows \|\| !rows\.length\) return;/);
  assert.match(PAGE, /_plotCursor = 'pointer';/);
  // Width, dashed and a second colour are per-instance and travel with it.
  assert.match(PAGE, /function indSetStyle\(i, key, v\)\{/);
  assert.match(PAGE, /if\(cfg\.dash && out\.series\[0\]\)/);
  assert.match(PAGE, /if\(cfg\.color2 && out\.series\[1\]\)/);
});

test('the account carries the chart settings the same way it carries the palette', () => {
  const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /info\.chart = chart;/);
  assert.match(PAGE, /_CS\.adopt\(e\.detail && e\.detail\.chart\)/, 'the page never adopts the account copy');
  assert.match(PAGE, /\{ chart: _CS\.diff\(_CS\.state\(\)\) \}/, 'the page sends more than the diff');
  assert.match(PAGE, /_csAdopting = true;/, 'adopting the account copy writes it straight back');
});

test('the session hours and the display zone are different things', () => {
  /* A Tokyo reader still wants the New York open marked where New York opens: regular
     hours, session breaks and pre/post shading are measured in _ET regardless of the
     zone the axis reads in. */
  assert.match(PAGE, /function _etMinutes\(ts\)\{[\s\S]*?timeZone:_ET/);
  assert.match(PAGE, /function _etTime\(d\)\{ return d\.toLocaleTimeString\('en-US',\{timeZone:_tz\(\)/);
  assert.match(PAGE, /ctx\.fillText\(_tzTag\(\), w-2, h-2\);/, 'the corner tag still says ET whatever the zone');
});
// ── the indicator dialog, second look (operator, 2026-09-13) ─────────────────

test('a click that re-renders its own dialog is not an outside click', () => {
  /* The Style tab closed the dialog. Its onclick rebuilt the dialog's innerHTML, so by
     the time the click reached the document listener its target was detached,
     `contains()` said no, and the outside-click rule fired. The same shape sits under
     the drawing flyout and both toolbar menus, so the rule now lives in one helper that
     treats a target with no place in the document as inside. */
  assert.match(PAGE, /function _clickInside\(el, e\)\{\s*return !!el && \(el\.contains\(e\.target\) \|\| !e\.target\.isConnected\);/);
  assert.match(PAGE, /_clickInside\(_indStyleEl, e\)/, 'the indicator dialog still uses bare containment');
  assert.match(PAGE, /_clickInside\(_styleEl, ev\)/, 'the drawing flyout still uses bare containment');
  assert.strictEqual((PAGE.match(/_clickInside\(m, e\)/g) || []).length, 2, 'both toolbar menus');
  assert.doesNotMatch(PAGE, /_indStyleEl\.contains\(e\.target\)/);
  assert.doesNotMatch(PAGE, /_styleEl\.contains\(ev\.target\)/);
  assert.doesNotMatch(PAGE, /\bm\.contains\(e\.target\)/);
});

test('one instance of an indicator, and no door for a second', () => {
  // The + that made "EMA 42" out of "EMA 21" is gone, the add list already hides what is
  // on the chart, and anything RESTORED is deduplicated by id before it is drawn.
  assert.doesNotMatch(PAGE, /indDuplicate/);
  assert.doesNotMatch(PAGE, /Add another/);
  assert.match(PAGE, /function _indDedupe\(list\)\{/);
  assert.match(PAGE, /let chartIndicators = \(\(\)=>\{\s*try\{ return _indDedupe\(/, 'the device copy is not deduplicated');
  assert.match(PAGE, /const clean = _indDedupe\(list\);/, 'the account copy is not deduplicated');
  assert.match(PAGE, /if\(chartIndicators\.some\(c=>c\.id===id\)\)\{\s*openIndicatorSettings/, 'adding twice does not open the existing one');
});

test('_indDedupe keeps the first of each id and drops what the registry does not know', () => {
  // Evaluated on its own: the function is pure over a registry lookup.
  const src = PAGE.slice(PAGE.indexOf('function _indDedupe(list){'), PAGE.indexOf('let chartIndicators = '));
  const fn = new Function('IND_DEFS', src + '; return _indDedupe;')({ ema: {}, rsi: {} });
  const out = fn([{ id: 'ema', params: { p: 21 } }, { id: 'ema', params: { p: 42 } }, { id: 'nope' }, null, { id: 'rsi' }, { id: 'rsi' }]);
  assert.deepStrictEqual(out.map((x) => x.id), ['ema', 'rsi']);
  assert.strictEqual(out[0].params.p, 21, 'the first copy is the one that stays');
  assert.deepStrictEqual(fn('not a list'), []);
  assert.strictEqual(fn(Array.from({ length: 40 }, (_, i) => ({ id: i % 2 ? 'ema' : 'rsi' }))).length, 2);
});
// ── the legend's text colour is its own decision (operator, 2026-09-13) ───────

test('indicator text can stay black-or-white while the line is coloured', () => {
  /* Every legend row and every pane label goes through one function, which reads the
     mode: the line's colour (the chart as it always drew), the chart's text colour, or
     one custom colour. */
  assert.match(PAGE, /function _indTextColour\(lineColour\)\{/);
  assert.match(PAGE, /if\(text\) _lines\.push\(\{ text, color: _indTextColour\(out\.series\[0\]\.color\) \}\);/, 'a legend row is written in the raw line colour');
  assert.match(PAGE, /ctx\.fillStyle=_indTextColour\(out\.series\[0\]\.color\); ctx\.textAlign='left'; ctx\.textBaseline='top';/, 'a pane label is written in the raw line colour');
  assert.strictEqual(CS.DEFAULTS['status.indText'], 'line', 'the default must be the chart as it drew before the setting existed');
  assert.strictEqual(CS.DEFAULTS['status.indTextColor'], null);
  assert.deepStrictEqual(CS.FIELDS['status.indText'].options.map((o) => o.v), ['line', 'text', 'custom']);
  // Chart text means the theme's primary text token, so it flips with light/dark.
  assert.match(PAGE, /if\(mode === 'text'\) return chartVar\('--tv-text-primary'/);
});

test('_indTextColour: line by default, the text token on request, the custom colour when given', () => {
  const src = PAGE.slice(PAGE.indexOf('function _indTextColour(lineColour){'), PAGE.indexOf('/* Status line: the legend text for one indicator'));
  const run = (mode, custom) => new Function('_cs', 'chartVar', src + '; return _indTextColour("#38bdf8");')(
    (k) => (k === 'status.indText' ? mode : k === 'status.indTextColor' ? custom : undefined), (name, fb) => (name === '--tv-text-primary' ? '#1a1d24' : fb));
  assert.strictEqual(run('line', null), '#38bdf8');
  assert.strictEqual(run(undefined, null), '#38bdf8', 'no module: the chart as before');
  assert.strictEqual(run('text', null), '#1a1d24');
  assert.strictEqual(run('custom', '#ff00ff'), '#ff00ff');
  assert.strictEqual(run('custom', null), '#1a1d24', 'custom with no colour picked yet falls back to the text token, not to nothing');
});

