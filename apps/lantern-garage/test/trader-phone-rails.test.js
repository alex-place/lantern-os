'use strict';
/**
 * test/trader-phone-rails.test.js — the phone rails leave the toolbar reachable (QA, 2026-09-14).
 *
 * At phone width the drawing rail and the dock rail are fixed in the band under the site
 * nav. The page has to start below that band -- the trader's toolbar row (layout, interval
 * and type pickers, Indicators, Settings) sat under the rails -- and the drawing rail must
 * stop where the dock rail starts, scrolling its tools rather than running under it.
 *
 * Run: node --test apps/lantern-garage/test/trader-phone-rails.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const phone = PAGE.slice(PAGE.indexOf('/* Phone: rails stay, both docks become bottom sheets.'), PAGE.indexOf('body.leftdock-closed .dockL,body.rightdock-closed .dockR{display:none}'));

test('the page starts below the rail band on phones', () => {
  assert.match(phone, /@media \(max-width:760px\)\{/);
  assert.match(phone, /:root\{--rail-band:50px;--dock-rail-w:124px\}/);
  assert.match(phone, /\.layout\{padding-top:var\(--rail-band\);box-sizing:border-box\}/);
  // Both rails still pin to the band itself.
  assert.match(phone, /\.draw-rail\{position:fixed;left:0;right:var\(--dock-rail-w\);top:52px;/);
  assert.match(phone, /\.dock-rail\{position:fixed;right:0;top:52px;/);
});

test('the drawing rail stops at the dock rail and scrolls its tools', () => {
  assert.match(phone, /\.draw-rail\{[^}]*overflow-x:auto;overflow-y:hidden;scrollbar-width:none\}/);
  assert.match(phone, /\.draw-rail::-webkit-scrollbar\{display:none\}/);
});
