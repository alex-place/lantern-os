'use strict';
/**
 * test/trader-pane-axis.test.js — an indicator pane's separator and scale (founder,
 * 2026-09-14: "the line separating the indicator is not visible enough, it should be
 * dotted; the separate value scale is shifted to the left; it needs to feel separate").
 *
 * Run: node --test apps/lantern-garage/test/trader-pane-axis.test.js
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
const paneTicks = new Function(fn('niceTicks') + fn('decimalsFor') + fn('_paneTicks') + '\nreturn _paneTicks;')();

test('a MACD strip gets nice ticks inside its range, one decimal, in the same 1/2/5 ladder as the price axis', () => {
  const t = paneTicks(-0.34, 0.53, 120);
  assert.ok(t.ticks.length >= 2 && t.ticks.length <= 5, 'two to five ticks: ' + t.ticks.join(','));
  for (const v of t.ticks) { assert.ok(v > -0.34 && v < 0.53, 'inside the range: ' + v); assert.ok(Math.abs(v / 0.2 - Math.round(v / 0.2)) < 1e-9, 'on the 0.2 ladder: ' + v); }
  assert.strictEqual(t.dec, 1);
});

test('an RSI strip reads 20/40/60/80 with no decimals; the edges stay clear of the separator', () => {
  const t = paneTicks(0, 100, 110);
  assert.deepStrictEqual(t.ticks, [20, 40, 60, 80]);
  assert.strictEqual(t.dec, 0);
});

test('a strip too short for a ladder shows its two ends, as before', () => {
  const t = paneTicks(-0.34, 0.53, 34);
  assert.deepStrictEqual(t.ticks, [0.53, -0.34]);
  assert.strictEqual(t.dec, 2);
  assert.deepStrictEqual(paneTicks(0, 100, 30), { ticks: [100, 0], dec: 0 });
});

test('the separator is dotted, in its own colour, across the whole width', () => {
  const at = PAGE.indexOf('// Canvas › pane separators');
  const around = PAGE.slice(at - 200, at + 400);
  assert.match(around, /_cs\('canvas\.paneSepColor'\) \|\| CHART_PANE_SEP_COLOR\(\)/);
  assert.match(around, /ctx\.setLineDash\(\[2,3\]\);\s*ctx\.beginPath\(\); ctx\.moveTo\(0, Math\.round\(top\)\+0\.5\); ctx\.lineTo\(w, Math\.round\(top\)\+0\.5\)/, 'dotted, from 0 to the canvas width (gutter included)');
  assert.match(PAGE, /'canvas\.paneSepColor': CHART_PANE_SEP_COLOR\(\)/, 'the settings default follows');
  assert.match(PAGE, /--tv-pane-sep:rgba\(255,255,255,\.3\)/, 'dark theme tone');
  assert.match(PAGE, /--tv-pane-sep:rgba\(0,0,0,\.3\)/, 'light theme tone');
});

test('the pane labels are set up after the restore, left-aligned in the price scale column', () => {
  const at = PAGE.indexOf('// Canvas › pane separators');
  const after = PAGE.slice(at, at + 900);
  const restoreAt = PAGE.lastIndexOf('ctx.restore();', at);
  assert.ok(restoreAt !== -1 && at - restoreAt < 300, 'the restore comes just before the separator and labels');
  assert.match(after, /ctx\.fillStyle=_axisColour\(\); ctx\.font=_axisFont\(\); ctx\.textAlign='left';/);
  assert.match(after, /ctx\.fillText\(fmt\(v, _pt\.dec\), pw\+4, ty\)/, 'the same x as the price labels (pw+4)');
  assert.doesNotMatch(PAGE, /ctx\.textAlign='left';\s*ctx\.restore\(\);/, 'no alignment set before a restore that would undo it');
});

test('the default strip height (78px) gets a full ladder; a shorter strip is thinned to every other rung', () => {
  assert.deepStrictEqual(paneTicks(-0.34, 0.53, 78), { ticks: [-0.2, 0, 0.2, 0.4], dec: 1 });
  assert.deepStrictEqual(paneTicks(0, 100, 78), { ticks: [20, 40, 60, 80], dec: 0 });
  const thin = paneTicks(0, 100, 60);                       // three labels fit, four rungs → every other one
  assert.deepStrictEqual(thin.ticks, [40, 80]);
  assert.ok(paneTicks(0.001, 0.009, 100).dec <= 4, 'decimals are capped');
});

test('the price pane draws no gridline on the separator row, so the dots stay visible', () => {
  assert.match(PAGE, /if\(_hGrid && !\(_paneN && yy >= priceH - 1\)\)\{/);
});
