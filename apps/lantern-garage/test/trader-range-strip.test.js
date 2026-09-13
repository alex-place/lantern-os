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

test('the buttons come from the RANGES table and the lit one is activeRange', () => {
  assert.match(PAGE, /function renderRangeRow\(\)\{/);
  assert.match(PAGE, /row\.innerHTML = Object\.keys\(RANGES\)\.map\(k =>/);
  assert.match(PAGE, /class="range-btn' \+ \(k === activeRange \? ' active' : ''\)/);
  assert.match(PAGE, /aria-pressed="' \+ \(k === activeRange \? 'true' : 'false'\)/, 'the lit state is colour-only');
  // syncRangeButtons (called on every timeframe change) rebuilds the row; init builds it too.
  const sync = PAGE.slice(PAGE.indexOf('function syncRangeButtons(tf){'), PAGE.indexOf('function renderRangeRow(){'));
  assert.match(sync, /renderRangeRow\(\);/);
  assert.ok(!PAGE.includes("['chartRangeSelect','fsChartRangeSelect']"), 'something still syncs the removed selects');
});

test('on phones the strip belongs to the Chart view', () => {
  assert.match(PAGE, /\.layout\.mobile-tickers \.range-strip,\s*\.layout\.mobile-positions \.range-strip\{ display:none; \}/);
  assert.match(PAGE, /\.range-strip\{ flex:0 0 auto; \}/);
});

test('the wall clock reads Eastern, like the axis, and ticks on its own', () => {
  assert.match(PAGE, /const _etClockFmt = new Intl\.DateTimeFormat\('en-US', \{ timeZone:_ET, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false \}\);/);
  assert.match(PAGE, /setInterval\(_tickEtClock, 1000\); _tickEtClock\(\);/);
});
