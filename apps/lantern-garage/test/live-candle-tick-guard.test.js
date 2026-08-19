'use strict';
// #3014 — the live-candle tick guard must reject stale/erroneous quotes (which permanently
// deform a forming bar's high/low and inflate ATR ~3.4×) while passing real intraday ticks.
// _plausibleTick is inline in stock-trader.html, so extract the ACTUAL source and exercise it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');
const decl = html.match(/const TICK_MAX_DEV = [^\n]+/);
const fnSrc = html.match(/function _plausibleTick\(px, open, close\)\{[\s\S]*?\n\}/);
assert.ok(decl && fnSrc, 'could not locate TICK_MAX_DEV / _plausibleTick in stock-trader.html');
// eslint-disable-next-line no-eval
const _plausibleTick = eval(`(function(){ ${decl[0]}; ${fnSrc[0]}; return _plausibleTick; })()`);

test('rejects the audited physically-impossible SPY wicks (≈6–7% off body)', () => {
  assert.strictEqual(_plausibleTick(696.82, 747.99, 747.99), false); // −51.18
  assert.strictEqual(_plausibleTick(699.05, 751.20, 751.20), false); // −52.15
  assert.strictEqual(_plausibleTick(787.52, 743.17, 743.17), false); // +44.35
});

test('passes normal intraday ticks (sub-percent moves)', () => {
  assert.strictEqual(_plausibleTick(748.10, 747.99, 748.05), true);
  assert.strictEqual(_plausibleTick(751.00, 751.20, 751.05), true);
});

test('does not clip a legitimately TRENDING bar (tick near the close, far from open)', () => {
  // open 745, close 759 (bar rose ~1.9%); a 760 tick is 0.13% from the close → keep it.
  assert.strictEqual(_plausibleTick(760, 745, 759), true);
});

test('rejects a non-positive / garbage price', () => {
  assert.strictEqual(_plausibleTick(0, 748, 748), false);
  assert.strictEqual(_plausibleTick(-5, 748, 748), false);
  assert.strictEqual(_plausibleTick(NaN, 748, 748), false);
});

test('fails OPEN when there is no positive anchor (can only remove ticks, never invent)', () => {
  assert.strictEqual(_plausibleTick(700, 0, 0), true);
});
