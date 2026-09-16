'use strict';
/**
 * test/trader-draw-position.test.js — the long and short position tools size the position
 * their settings describe.
 *
 * Account size, Risk % and Lot size were offered and read by nothing, and the Position size
 * switch showed nothing, so the one drawing tool that exists to plan a trade advertised
 * position sizing and performed none. The target's own price was never drawn either.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-position.test.js
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
const size = new Function(fn('drawPositionSize') + '\nreturn drawPositionSize;')();

const swStart = PAGE.indexOf('switch (d.t) {', PAGE.indexOf('const shade = (fn, a) =>'));
const posCase = PAGE.slice(PAGE.indexOf("case 'pos': case 'poss': {", swStart), PAGE.indexOf("case 'meas': {", swStart));

test('the size is the cash at risk over the distance to the stop, in whole lots', () => {
  // $10,000 at 1% is $100 at risk; a $2 stop distance buys 50 units.
  assert.strictEqual(size(10000, 1, 1, 2), 50);
  assert.strictEqual(size(10000, 2, 1, 2), 100, 'twice the risk, twice the size');
  assert.strictEqual(size(10000, 1, 1, 4), 25, 'a wider stop buys fewer');
  assert.strictEqual(size(10000, 1, 10, 2), 50, 'a round number of lots needs no rounding');
  assert.strictEqual(size(10000, 1, 30, 2), 30, '50 rounds DOWN to one lot of 30, never up');
  assert.strictEqual(size(1000, 1, 1, 3), 3, '$10 at risk over $3 is 3 units, not 3.33');
});

test('it answers zero rather than a number it cannot stand behind', () => {
  assert.strictEqual(size(0, 1, 1, 2), 0, 'no account');
  assert.strictEqual(size(10000, 0, 1, 2), 0, 'no risk budget');
  assert.strictEqual(size(10000, 1, 1, 0), 0, 'entry and stop at the same price');
  assert.strictEqual(size(10000, 1, 1, -2), 0, 'a negative distance is not a distance');
  assert.strictEqual(size(null, undefined, NaN, 2), 0, 'nothing set at all');
  assert.strictEqual(size(10000, 1, 0, 2), 50, 'a lot of zero means one, not a division by zero');
});

test('the painter shows the size, and each switch decides its own line', () => {
  assert.match(posCase, /const qty = drawPositionSize\(drawOptOf\(d, 'account'\), drawOptOf\(d, 'riskPct'\), drawOptOf\(d, 'lot'\), risk\);/);
  assert.match(posCase, /if \(drawOptOf\(d, 'showR'\) !== false\) head\.push\(rr\.toFixed\(2\) \+ 'R'\);/);
  assert.match(posCase, /if \(drawOptOf\(d, 'showQty'\) !== false && qty > 0\)/, 'a size it cannot compute is not printed');
  assert.match(posCase, /if \(drawOptOf\(d, 'showPrices'\) !== false\) \{/);
  // the target's price, which was never drawn
  assert.match(posCase, /tag\('target ' \+ fmt\(tg\.price, 2\), x2 - 3, tg\.y - 2, 'right'\);/);
  assert.match(posCase, /tag\('entry ' \+ fmt\(e0\.price, 2\), x2 - 3, e0\.y - 2, 'right'\);/);
  assert.match(posCase, /tag\('stop ' \+ fmt\(st\.price, 2\), x2 - 3, st\.y - 2, 'right'\);/);
  // the summary sits above the whole box, not on the target line, or it would collide
  assert.match(posCase, /tag\(head\.join\('  '\), x1 \+ 3, Math\.max\(11, Math\.min\(tg\.y, e0\.y, st\.y\) - 15\)\);/);
});

test('every option the position tools offer is read', () => {
  const specStart = PAGE.indexOf('const FIB_COLORS = {');
  const spec = new Function('DRAW_COLOR', 'drawDefaultColor',
    PAGE.slice(specStart, PAGE.indexOf('\nconst drawSpecOf', specStart)) + '\nreturn DRAW_SPEC;')('#a78bfa', () => '#a78bfa');
  const reads = new Set([...posCase.matchAll(/drawOpt(?:Of|Set)\(d, ?'([a-zA-Z0-9_]+)'\)/g)].map((m) => m[1]));
  const generic = new Set(['color', 'w', 'dash']);
  for (const t of ['pos', 'poss']) {
    const keys = [].concat(spec[t].inputs, spec[t].style, spec[t].vis).map((f) => f.k);
    const dead = keys.filter((k) => !generic.has(k) && !reads.has(k));
    assert.deepStrictEqual(dead, [], t + ' offers but never reads: ' + dead.join(', '));
  }
  assert.strictEqual(spec.poss, spec.pos, 'the short shares the long\'s settings');
});
