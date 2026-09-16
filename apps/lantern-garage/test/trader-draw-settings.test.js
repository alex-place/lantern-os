'use strict';
/**
 * test/trader-draw-settings.test.js — every option in a drawing tool's settings dialog
 * does what its label says (founder, 2026-09-14: "test the fib and channel tools more").
 *
 * The first test is the audit that found the problem: for each tool, every key its
 * DRAW_SPEC offers is read by its painter (directly, or through the shared shade() for
 * fill colour / opacity, or through fibColorOf for level colours). It fails the moment a
 * dialog grows a control the painter ignores.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-settings.test.js
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

// The dialog's catalogue, evaluated as the page does.
const specStart = PAGE.indexOf('const FIB_COLORS = {');
const specEnd = PAGE.indexOf('\nconst drawSpecOf', specStart);
assert.ok(specStart > 0 && specEnd > specStart, 'DRAW_SPEC block not found');
// The block now ends by handing each tool that stated no colour of its own its family's,
// so the sandbox has to supply the two names that loop reads. Colour values are not this
// test's subject (trader-draw-colors is), so the stub leaves every default where it was.
const { DRAW_SPEC, FIB_COLORS } = new Function('DRAW_COLOR', 'drawDefaultColor', PAGE.slice(specStart, specEnd) + '\nreturn { DRAW_SPEC, FIB_COLORS };')('#a78bfa', () => '#a78bfa');

// The painter's cases, by tool id.
const swStart = PAGE.indexOf('switch (d.t) {', PAGE.indexOf('const shade = (fn, a) =>'));
const swEnd = PAGE.indexOf('_drawOne = drawOne;', swStart);
assert.ok(swStart > 0 && swEnd > swStart, 'drawOne switch not found');
const SW = PAGE.slice(swStart, swEnd);
const HELPERS = PAGE.slice(PAGE.indexOf('const fillA = () =>'), swStart);   // fillA, shade, xEnd, priceTag ...
const cases = {};
const marks = [...SW.matchAll(/\n(\s*)case ([^\n]*?)\{/g)].map((m) => ({ at: m.index, label: m[2] }));
marks.forEach((m, i) => {
  const body = SW.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : SW.length);
  for (const id of [...m.label.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])) cases[id] = body;
});

const TOOLS = ['fib', 'fibx', 'fibchan', 'fibtime', 'fibcirc', 'fibfan', 'gannfan', 'gannbox',
               'chan', 'flat', 'fork', 'regr', 'djchan', 'rect', 'ell', 'tri', 'meas', 'range', 'drange', 'proj'];

test('every option a tool offers is read by its painter', () => {
  const generic = new Set(['color', 'w', 'dash']);                      // drawStyleOf, for every tool
  const viaShade = new Set(['fillColor', 'fillAlpha']);                  // the shared shade()
  assert.match(HELPERS, /drawOptOf\(d, 'fillColor'\)/); assert.match(HELPERS, /drawOptOf\(d, 'fillAlpha'\)/);
  const missing = [];
  for (const t of TOOLS) {
    const sp = DRAW_SPEC[t] || DRAW_SPEC._default;
    const keys = [].concat(sp.inputs || [], sp.style || [], sp.vis || []).map((f) => f.k);
    const body = cases[t]; assert.ok(body, 'no painter case for ' + t);
    const reads = new Set([...body.matchAll(/drawOptOf\(d,\s*'([a-zA-Z0-9_]+)'\)/g)].map((m) => m[1]));
    // helpers the case calls read these on its behalf
    if (/\bshade\(/.test(body)) viaShade.forEach((k) => reads.add(k));
    if (/\bxEnd\(/.test(body)) reads.add('extendRight');
    if (/\bpriceTag\(/.test(body)) reads.add('showLabels');
    if (/\bsizeTag\(/.test(body)) reads.add('showSize');
    const levelColours = /fibColorOf\(d, lv\)/.test(body);
    for (const k of keys) {
      if (generic.has(k) || reads.has(k)) continue;
      if (/^c\d+$/.test(k) && levelColours) continue;
      missing.push(t + '.' + k);
    }
  }
  assert.deepStrictEqual(missing, [], 'offered but never read: ' + missing.join(', '));
});

test('the extension\'s dialog offers the levels it draws, and fibColorOf knows them', () => {
  const keys = DRAW_SPEC.fibx.style.map((f) => f.k);
  assert.deepStrictEqual(keys.filter((k) => /^c/.test(k)), ['c0', 'c618', 'c100', 'c1618', 'c2618']);
  assert.ok(!keys.includes('c236') && !keys.includes('c382'), 'no retracement-only colours');
  const fibColorOf = new Function('FIB_COLORS', fn('fibColorOf') + '\nreturn fibColorOf;')(FIB_COLORS);
  assert.strictEqual(fibColorOf({ style: { c1618: '#123456' } }, 1.618), '#123456', 'the 161.8% colour is the dialog\'s');
  assert.strictEqual(fibColorOf({}, 2.618), FIB_COLORS[2.618], 'and falls back to the palette');
});

test('defaults keep the look: no extension and no channel labels until asked; fill opacity says 16', () => {
  for (const t of ['chan', 'flat', 'fibchan']) assert.strictEqual(DRAW_SPEC[t].inputs.find((f) => f.k === 'extendRight').def, false, t);
  assert.strictEqual(DRAW_SPEC.fork.inputs.find((f) => f.k === 'extendRight').def, true, 'a pitchfork always ran to the edge');
  for (const t of ['chan', 'flat', 'fork', 'regr', 'djchan']) assert.strictEqual(DRAW_SPEC[t].vis.find((f) => f.k === 'showLabels').def, false, t);
  assert.strictEqual(DRAW_SPEC.rect.style.find((f) => f.k === 'fillAlpha').def, 16);
  assert.match(HELPERS, /\(v == null \|\| v === ''\) \? 0\.16/, 'a tool without the option still shades at 16%');
});

// ── the hit test follows Extend right ────────────────────────────────────────────────
const MIN = 60000;
function chart() {
  const bars = [];
  let t = Date.UTC(2026, 8, 14, 13, 30);
  for (let i = 0; i < 100; i++, t += 5 * MIN) bars.push({ timestamp: new Date(t).toISOString(), close: 150 });
  return { bars, rMin: 100, rMax: 200 };
}
const PW = 500, PH = 300;
const tsOfBar = (bars, i) => +new Date(bars[i].timestamp);
const yOf = (p) => ((200 - p) / 100) * PH;
function hitter(drawings) {
  const src = fn('_drawTimeMap') + fn('_regrBand') + fn('_drawTextWidth').replace('let _measureCtx = null;', '') + fn('_hitDrawing');
  return new Function('_drawings', '_paneMapper', '_slotsFor', 'FIB_LEVELS', 'FIB_EXT', 'drawOptOf', 'document',
    'let _measureCtx = null;\n' + src + '\nreturn _hitDrawing;')(
    drawings, () => null, (n) => n + 25, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], [0, 0.618, 1, 1.618, 2.618],
    (d, k) => (d.opts || {})[k], undefined);
}

test('a channel with Extend right on is a hit out to the plot\'s edge; off, it ends at its anchors', () => {
  const data = chart(), b = data.bars;
  const mk = (opts) => ({ t: 'chan', opts, pts: [{ ts: tsOfBar(b, 10), price: 160 }, { ts: tsOfBar(b, 40), price: 160 }, { ts: tsOfBar(b, 25), price: 150 }] });
  const farInBand = [PW - 10, yOf(155)];                      // right of the second anchor, inside the band's height
  assert.strictEqual(hitter({ SPY: [mk({})] })('SPY', data, farInBand[0], farInBand[1], PW, PH, 14), null, 'not extended: nothing out there');
  const on = hitter({ SPY: [mk({ extendRight: true })] })('SPY', data, farInBand[0], farInBand[1], PW, PH, 14);
  assert.ok(on && on.i === 0, 'extended: the band reaches the edge');
});

test('a fib with Extend levels right off ends at its second anchor', () => {
  const data = chart(), b = data.bars;
  const fib = (opts) => ({ t: 'fib', opts, pts: [{ ts: tsOfBar(b, 10), price: 120 }, { ts: tsOfBar(b, 30), price: 180 }] });
  const y50 = yOf(150);
  assert.ok(hitter({ SPY: [fib({})] })('SPY', data, PW - 6, y50, PW, PH, 14), 'default: to the edge');
  assert.strictEqual(hitter({ SPY: [fib({ extendRight: false })] })('SPY', data, PW - 6, y50, PW, PH, 14), null, 'off: not at the edge');
  assert.ok(hitter({ SPY: [fib({ extendRight: false })] })('SPY', data, 30 * 4 + 2 - 10, y50, PW, PH, 14), 'off: still on the level within the span');
});

test('elapsed time reads the way a trader says it', () => {
  const f = new Function(fn('_fmtElapsed') + '\nreturn _fmtElapsed;')();
  assert.strictEqual(f(45 * 60000), '45m');
  assert.strictEqual(f((3 * 60 + 20) * 60000), '3h 20m');
  assert.strictEqual(f(2 * 24 * 3600000 + 4 * 3600000), '2d 4h');
  assert.strictEqual(f(-90 * 60000), '1h 30m', 'direction does not matter');
});
