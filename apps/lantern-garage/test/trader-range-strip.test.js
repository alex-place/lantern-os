'use strict';
/**
 * test/trader-range-strip.test.js — the range buttons under the charts (operator, 2026-09-13).
 *
 * TradingView keeps the 1D…All buttons on the chart's own bottom edge, right above the
 * account panel, with the session clock on the right. Ours moved there from the toolbar.
 * Source assertions: the strip is its own grid row between the charts and the panel, every
 * rail and dock spans it, the buttons are built from the one RANGES table, and on phones
 * it belongs to the Chart view like the charts it sits under.
 *
 * Run: node --test apps/lantern-garage/test/trader-range-strip.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');

test('the strip sits between the charts and the account panel', () => {
  const main = PAGE.indexOf('<div class="main" role="main" aria-label="Charts">');
  const strip = PAGE.indexOf('<div class="range-strip" id="rangeStrip">');
  const footer = PAGE.indexOf('<div class="footer" style="position:relative">');
  assert.ok(main > 0 && strip > main && footer > strip, 'main → strip → footer, in that order');
  assert.match(PAGE, /\.range-strip\{grid-column:3;grid-row:3;/);
  assert.match(PAGE, /\.footer\{position:relative;grid-column:3;grid-row:4;/, 'the panel did not move down a row');
  assert.match(PAGE, /grid-template-rows:52px minmax\(0,1fr\) auto var\(--footer-h/, 'the layout has no row for it');
});

test('every rail and dock spans the new row, so nothing ends a row short', () => {
  // A dock that still spanned two rows would stop above the strip and leave a hole.
  assert.strictEqual((PAGE.match(/grid-row:2 \/ span 2;/g) || []).length, 0);
  assert.strictEqual((PAGE.match(/grid-row:2 \/ span 3;/g) || []).length, 5);
  assert.match(PAGE, /\.sidebar\{grid-column:1;grid-row:2 \/ 5;/);
});

test('the toolbar no longer carries the range select or the clock; the strip does', () => {
  assert.ok(!PAGE.includes('id="chartRangeSelect"'), 'the range <select> is still on the toolbar');
  assert.strictEqual((PAGE.match(/id="mktClockWrap"/g) || []).length, 1);
  const strip = PAGE.slice(PAGE.indexOf('<div class="range-strip"'), PAGE.indexOf('<!-- Footer -->'));
  assert.ok(strip.includes('id="mktClockWrap"'), 'the clock is not on the strip');
  assert.ok(strip.includes('id="etClock"'), 'no wall clock on the strip');
  // The ids the session-clock code writes survive the move, so nothing else changes.
  assert.strictEqual((PAGE.match(/id="mktClockLabel"/g) || []).length, 1);
  assert.strictEqual((PAGE.match(/id="mktClock"/g) || []).length, 1);
});

test('the buttons come from the RANGES table; the lit one is derived from the view, never stored', () => {
  /* A range button is one click -- interval, window and price refit on every chart -- and
     nothing is saved as a mode (2026-09-13). But the strip SHOWS which span the charts are
     on: the button whose span the last interval change set, until a zoom or a pan takes
     a chart off it. Feedback, not a mode -- the way TradingView's buttons light. */
  assert.match(PAGE, /function renderRangeRow\(\)\{/);
  assert.match(PAGE, /row\.innerHTML = Object\.keys\(RANGES\)\.map\(k => \{/);
  assert.match(PAGE, /const lit = !_rangeTouched && RANGES\[k\] === _rangeSpan;/);
  assert.match(PAGE, /let _rangeSpan = SPAN_FOR_TF\[chartTimeframe\] \|\| null, _rangeTouched = false;/, 'at boot the remembered interval lights its own span');
  assert.ok(!PAGE.includes('activeRange'), 'a stored lit state is back');
  assert.ok(!PAGE.includes("'trader.range'"), 'the range is saved as a mode again');
  assert.ok(!PAGE.includes('function syncRangeButtons'), 'a lit state is still being synced');
  // Every interval change re-derives it; zoom and pan un-light; an axis reset re-lights.
  assert.match(PAGE, /_rangeSpan = span \|\| SPAN_FOR_TF\[tf\] \|\| null; _rangeTouched = false; renderRangeRow\(\);/);
  assert.strictEqual((PAGE.match(/_rangeLeft\(\);/g) || []).length, 2, 'zoom and pan each un-light the range');
  assert.match(PAGE, /view\.spanDriven = true;   \/\/ back to the span\s*_rangeTouched = false; renderRangeRow\(\);/);
});

test('the toolbar chips re-read the interval a range click set', () => {
  /* The chips are custom widgets over native <select>s and resync only on a 'change'
     event; `.value = tf` from code fired none, so the candle-size chip kept its old
     label after every range click. */
  assert.match(PAGE, /sel\._uiSync = sync;/);
  assert.match(PAGE, /function _setSelectValue\(id, value\) \{[\s\S]*?if \(sel\._uiSync\) sel\._uiSync\(\);/);
  const ct = PAGE.slice(PAGE.indexOf('function changeTimeframe(tf, span){'), PAGE.indexOf('function changeRange('));
  assert.match(ct, /_setSelectValue\('chartTfSelect', tf\);/);
  assert.ok(!ct.includes(".value = tf"), 'changeTimeframe still sets the native value behind the chip');
  const cc = PAGE.slice(PAGE.indexOf('function changeChartType(type){'), PAGE.indexOf('function changeTimeframe(tf, span){'));
  assert.match(cc, /_setSelectValue\('chartTypeSelect', type\);/);
});

test('on phones the strip belongs to the Chart view', () => {
  assert.match(PAGE, /\.layout\.mobile-tickers \.range-strip,\s*\.layout\.mobile-positions \.range-strip\{ display:none; \}/);
  assert.match(PAGE, /\.range-strip\{ flex:0 0 auto; \}/);
});

test('the wall clock reads Eastern, like the axis, and ticks on its own', () => {
  assert.match(PAGE, /const _etClockFmt = new Intl\.DateTimeFormat\('en-US', \{ timeZone:_ET, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false \}\);/);
  assert.match(PAGE, /setInterval\(_tickEtClock, 1000\); _tickEtClock\(\);/);
});
