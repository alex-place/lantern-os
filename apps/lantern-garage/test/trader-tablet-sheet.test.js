'use strict';
/**
 * test/trader-tablet-sheet.test.js — between phone and desktop (581–760px) the watchlist
 * sheet rests collapsed, so it no longer covers the chart and the account panel (2026-10-11).
 *
 * The right dock is permanent (a closed one once could not be reopened), and at ≤760px it
 * is a bottom sheet 62vh tall. Together: a sheet OPEN over 62% of the screen that nothing
 * could move — measured at 671px, it covered the lower 56% of the chart (where the latest
 * price is) and the entire account panel. Phones (≤580px) have the one-view shell and were
 * never affected; desktop is a column.
 *
 * Run: node --test apps/lantern-garage/test/trader-tablet-sheet.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const BAND = '(min-width:581px) and (max-width:760px)';

test('in the band the sheet rests at its header, and the layout keeps that strip clear', () => {
  const at = PAGE.indexOf('@media ' + BAND + '{');
  assert.ok(at > 0, 'the band rule exists');
  const block = PAGE.slice(at, PAGE.indexOf('\n  }\n', at));
  assert.match(block, /body:not\(\.rsheet-open\) \.dockR\{height:46px;overflow:hidden\}/);
  assert.match(block, /body:not\(\.rsheet-open\) \.dockR \.dock-body\{display:none\}/);
  assert.match(block, /\.layout\{padding-bottom:46px\}/, 'nothing sits under the resting sheet');
  // ...and it amends the ≤760px sheet rule, so it must come after it in the sheet
  assert.ok(at > PAGE.indexOf('.dockL,.dockR{position:fixed;left:0;right:0;bottom:0;top:auto;height:62vh;z-index:1200;'));
});

test('the header opens and closes it; a dock tab opens it; picking a symbol closes it', () => {
  assert.ok(PAGE.includes("window.matchMedia('" + BAND + "')"), 'the script asks the same band as the CSS');
  const fnAt = PAGE.indexOf("document.addEventListener('click', (e) => {\n  if (!_isSheetBand()");
  assert.ok(fnAt > 0);
  const fn = PAGE.slice(fnAt, PAGE.indexOf('}, true);', fnAt) + 9);
  assert.match(fn, /closest\('#dockR \.dock-head'\)\) \{ document\.body\.classList\.toggle\('rsheet-open'\)/);
  assert.match(fn, /closest\('#dockR \.wl-item'\)\) document\.body\.classList\.remove\('rsheet-open'\)/);
  assert.match(fn, /closest\('#dockR button, #dockR a, #dockR select, #dockR input'\)\) return;/, "a row's own buttons keep their job");
  assert.ok(fn.endsWith('}, true);'), 'CAPTURE: a row click re-renders the list and detaches its target before bubbling');
  const srw = PAGE.slice(PAGE.indexOf('function setRightWidget(name) {'), PAGE.indexOf('function closeRightWidget()'));
  assert.match(srw, /if \(_isSheetBand\(\)\) document\.body\.classList\.add\('rsheet-open'\);/);
});

test('phones and the desktop are untouched', () => {
  assert.match(PAGE, /return typeof window\.matchMedia === 'function' && window\.matchMedia\('\(max-width:580px\)'\)\.matches;/, 'the phone shell still starts at 580');
  assert.match(PAGE, /let _rightOpen = true;/, 'the dock is still permanent — collapsed is not closed');
});
