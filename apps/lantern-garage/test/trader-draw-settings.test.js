'use strict';
/**
 * test/trader-draw-settings.test.js — every option every drawing tool offers does what its
 * label says.
 *
 * The first version of this audit covered twenty tools and found a dialog full of controls
 * the painter never read. It also had two blind spots: it skipped any case written without
 * braces (`case 'l': seg(...)`) and any case with a blank line above it, which hid fifteen
 * more tools. It covers all forty-seven now, and it is the reason a dialog cannot grow a
 * dead control again.
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

// The catalogue of tools, and the catalogue of their settings.
const catStart = PAGE.indexOf('const DRAW_CATS = [');
const catEnd = PAGE.indexOf('\n})();', PAGE.indexOf('const DRAW_TOOLS = (() => {', catStart)) + 6;
const DRAW_TOOLS = new Function('ico', PAGE.slice(catStart, catEnd) + '\nreturn DRAW_TOOLS;')(() => '');
const specStart = PAGE.indexOf('const FIB_COLORS = {');
const specEnd = PAGE.indexOf('\nconst drawSpecOf', specStart);
// The block ends by handing each tool that stated no colour of its own its family's, so the
// sandbox supplies the two names that loop reads. Colour VALUES are trader-draw-colors'
// subject, not this file's, so the stub leaves every default where it was.
const DRAW_SPEC = new Function('DRAW_COLOR', 'drawDefaultColor',
  PAGE.slice(specStart, specEnd) + '\nreturn DRAW_SPEC;')('#a78bfa', () => '#a78bfa');

/* Each painter case, by tool id. Every `case 'id':` counts, braced or not, wherever it sits
   — the two shapes this missed before were `case 'l': seg(...)` on one line and a case with
   a blank line above it. Labels separated only by whitespace share one body. */
const swStart = PAGE.indexOf('switch (d.t) {', PAGE.indexOf('const shade = (fn, a) =>'));
const swEnd = PAGE.indexOf('_drawOne = drawOne;', swStart);
assert.ok(swStart > 0 && swEnd > swStart, 'the painter switch was not found');
const SW = PAGE.slice(swStart, swEnd);
const groups = [];
for (const m of SW.matchAll(/case '([a-z0-9]+)'\s*:/g)) {
  const prev = groups[groups.length - 1];
  if (prev && /^\s*$/.test(SW.slice(prev.end, m.index))) { prev.ids.push(m[1]); prev.end = m.index + m[0].length; }
  else groups.push({ at: m.index, end: m.index + m[0].length, ids: [m[1]] });
}
const cases = {};
groups.forEach((g, i) => {
  const body = SW.slice(g.at, i + 1 < groups.length ? groups[i + 1].at : SW.length);
  for (const id of g.ids) cases[id] = body;
});

const DRAWS = Object.keys(DRAW_TOOLS).filter((t) => !DRAW_TOOLS[t].cursor && !DRAW_TOOLS[t].erase);
const FIB_KEYS = ['c0', 'c236', 'c382', 'c50', 'c618', 'c786', 'c100', 'c1272', 'c1618', 'c2618'];

/** What this painter reads, directly or through a helper that reads on its behalf. */
function readsOf(body) {
  const reads = new Set([...body.matchAll(/drawOpt(?:Of|Set)\(d, ?'([a-zA-Z0-9_]+)'\)/g)].map((m) => m[1]));
  if (/\bshade\(/.test(body)) { reads.add('fillColor'); reads.add('fillAlpha'); }
  if (/\bxEnd\(/.test(body)) reads.add('extendRight');
  if (/\bspanOf\(/.test(body)) { reads.add('extendLeft'); reads.add('extendRight'); }
  if (/\bpriceTag\(/.test(body)) reads.add('showLabels');
  if (/d\.text/.test(body)) reads.add('text');
  if (/fibColorOf\(d, lv\)/.test(body)) for (const k of FIB_KEYS) reads.add(k);
  return reads;
}

test('every tool that draws has a painter, and every option it offers is read', () => {
  const generic = new Set(['color', 'w', 'dash']);        // drawStyleOf / drawOptOf, for every tool
  assert.ok(DRAWS.length >= 47, 'the catalogue shrank: ' + DRAWS.length);
  const noCase = DRAWS.filter((t) => !cases[t]);
  assert.deepStrictEqual(noCase, [], 'offered in the picker, drawn by nothing: ' + noCase.join(', '));
  const missing = [];
  for (const t of DRAWS) {
    const spec = DRAW_SPEC[t] || DRAW_SPEC._default;
    const reads = readsOf(cases[t]);
    for (const f of [].concat(spec.inputs || [], spec.style || [], spec.vis || []))
      if (!generic.has(f.k) && !reads.has(f.k)) missing.push(t + '.' + f.k);
  }
  assert.deepStrictEqual(missing, [], 'offered but never read: ' + missing.join(', '));
});

test('the helpers the audit trusts really do read on a painter\'s behalf', () => {
  // If one of these stops reading its option, the audit above would wave through every
  // tool that relies on it, so they are pinned here.
  const helpers = PAGE.slice(PAGE.indexOf('const fillA = () =>'), swStart);
  assert.match(helpers, /drawOptOf\(d, 'fillColor'\)/);
  assert.match(helpers, /drawOptOf\(d, 'fillAlpha'\)/);
  assert.match(helpers, /const xEnd = \(a, b\) => drawOptOf\(d, 'extendRight'\)/);
  assert.match(helpers, /const spanOf = \(a, b\) => \{[\s\S]*?drawOptOf\(d, 'extendLeft'\)[\s\S]*?drawOptOf\(d, 'extendRight'\)/);
  assert.match(helpers, /const priceTag = \(x, yy\) => \{ if \(drawOptOf\(d, 'showLabels'\)\)/);
  // sizeTag only paints: its callers decide, with an explicit drawOptOf, so it needs no rule.
  assert.match(PAGE, /if \(drawOptOf\(d, 'showSize'\)\) sizeTag\(/);
});

test('a tool does not offer what its own identity already decides', () => {
  // A ray runs right and an extended line runs both ways -- that is what those tools ARE,
  // so a switch for it could only ever lie. The trend line, which has ends, keeps it.
  for (const t of ['ray', 'xline', 'hray'])
    assert.deepStrictEqual((DRAW_SPEC[t].inputs || []).map((f) => f.k), [], t + ' offers an extension it cannot honour');
  assert.deepStrictEqual(DRAW_SPEC.l.inputs.map((f) => f.k), ['extendLeft', 'extendRight']);
  assert.deepStrictEqual(DRAW_SPEC.h.inputs.map((f) => f.k), ['extendRight']);
});

test('the level families still colour each level, and the extension has its own', () => {
  const keys = DRAW_SPEC.fibx.style.map((f) => f.k);
  assert.deepStrictEqual(keys.filter((k) => /^c/.test(k)), ['c0', 'c618', 'c100', 'c1618', 'c2618']);
  for (const t of ['fib', 'fibchan', 'fibcirc', 'fibfan'])
    assert.match(cases[t], /fibColorOf\(d, lv\)/, t + ' stopped colouring its levels');
});

test('defaults keep what each tool painted before its options worked', () => {
  for (const t of ['chan', 'flat', 'fibchan']) assert.strictEqual(DRAW_SPEC[t].inputs.find((f) => f.k === 'extendRight').def, false, t);
  assert.strictEqual(DRAW_SPEC.fork.inputs.find((f) => f.k === 'extendRight').def, true, 'a pitchfork always ran to the edge');
  assert.strictEqual(DRAW_SPEC.h.inputs.find((f) => f.k === 'extendRight').def, true, 'a level always crossed the chart');
  for (const t of ['chan', 'flat', 'fork', 'regr', 'djchan']) assert.strictEqual(DRAW_SPEC[t].vis.find((f) => f.k === 'showLabels').def, false, t);
  for (const t of ['h', 'hray']) assert.strictEqual(DRAW_SPEC[t].vis.find((f) => f.k === 'showLabels').def, true, t + ' always showed its price');
  assert.strictEqual(DRAW_SPEC.rect.style.find((f) => f.k === 'fillAlpha').def, 16);
  const helpers = PAGE.slice(PAGE.indexOf('const fillA = () =>'), swStart);
  assert.match(helpers, /\(v == null \|\| v === ''\) \? 0\.16/, 'a tool without the option still shades at 16%');
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
  const farInBand = [PW - 10, yOf(155)];
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
