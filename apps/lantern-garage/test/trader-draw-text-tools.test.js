'use strict';
/**
 * test/trader-draw-text-tools.test.js — the five tools whose content is words
 * (text, note, callout, comment balloon, price label).
 *
 * Their words were asked for once, by a browser prompt at placement, and could never be
 * changed: the settings dialog could only render colour, number and checkbox fields. Their
 * style options moved nothing either — Text and Note painted a hardcoded 11px with no
 * background whatever Font size, Bold and Background said, and Wrap long text did nothing
 * at all, so a long note ran off the side of the chart in one line.
 *
 * Run: node --test apps/lantern-garage/test/trader-draw-text-tools.test.js
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

const specStart = PAGE.indexOf('const FIB_COLORS = {');
const specEnd = PAGE.indexOf('\nconst drawSpecOf', specStart);
const DRAW_SPEC = new Function('DRAW_COLOR', 'drawDefaultColor',
  PAGE.slice(specStart, specEnd) + '\nreturn DRAW_SPEC;')('#a78bfa', () => '#a78bfa');

// The painter's cases, by tool id.
const swStart = PAGE.indexOf('switch (d.t) {', PAGE.indexOf('const shade = (fn, a) =>'));
const swEnd = PAGE.indexOf('_drawOne = drawOne;', swStart);
const SW = PAGE.slice(swStart, swEnd);
const cases = {};
const marks = [...SW.matchAll(/\n(\s*)case ([^\n]*?)\{/g)].map((m) => ({ at: m.index, label: m[2] }));
marks.forEach((m, i) => {
  const body = SW.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : SW.length);
  for (const id of [...m.label.matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1])) cases[id] = body;
});

const TEXT_TOOLS = ['text', 'note', 'callout', 'balloon', 'plabel'];

test('every option these five offer is read by its painter, the words included', () => {
  const generic = new Set(['color', 'w', 'dash']);
  const missing = [];
  for (const t of TEXT_TOOLS) {
    const body = cases[t]; assert.ok(body, 'no painter case for ' + t);
    const reads = new Set([...body.matchAll(/drawOpt(?:Of|Set)\(d,\s*'([a-zA-Z0-9_]+)'\)/g)].map((m) => m[1]));
    if (/d\.text/.test(body)) reads.add('text');
    const keys = [].concat(DRAW_SPEC[t].inputs || [], DRAW_SPEC[t].style || [], DRAW_SPEC[t].vis || []).map((f) => f.k);
    for (const k of keys) if (!generic.has(k) && !reads.has(k)) missing.push(t + '.' + k);
  }
  assert.deepStrictEqual(missing, [], 'offered but never read: ' + missing.join(', '));
});

test('the words are editable after the fact, and first on the Inputs tab', () => {
  for (const t of TEXT_TOOLS) {
    const f = (DRAW_SPEC[t].inputs || [])[0];
    assert.ok(f && f.k === 'text' && f.type === 'text', t + ' has no text field first on Inputs');
  }
  // the dialog can render that type, reading and writing the drawing's own text
  const dlg = fn('openDrawingSettings');
  assert.match(dlg, /if \(f\.type === 'text'\) h \+= '<input type="text"[^']*value="' \+ _esc\(d\.text == null \? '' : d\.text\)/);
  assert.match(dlg, /setDrawText\(\\'' \+ tk \+ '\\','/, 'the text field does not write through setDrawText');
  const setter = fn('setDrawText');
  assert.match(setter, /d\.text = String\(val == null \? '' : val\)\.slice\(0, 160\);/);
  assert.match(setter, /_saveDrawings\(\); _refreshTicker\(tk\);/);
  // and it is still collected at placement, for the tools that ask
  assert.match(PAGE, /if \(spec\.text\) \{/);
});

test('wrapping breaks on words, keeps one too long, and survives empty text', () => {
  const wrap = new Function(fn('_wrapLines') + '\nreturn _wrapLines;')();
  const ctx = { measureText: (t) => ({ width: t.length * 6 }) };          // 6px a character
  assert.deepStrictEqual(wrap(ctx, '', 100), ['']);
  assert.deepStrictEqual(wrap(ctx, null, 100), ['']);
  assert.deepStrictEqual(wrap(ctx, 'one two', 100), ['one two']);         // 42px, fits
  assert.deepStrictEqual(wrap(ctx, 'aaa bbb ccc ddd', 60), ['aaa bbb', 'ccc ddd']);
  assert.deepStrictEqual(wrap(ctx, 'supercalifragilistic', 30), ['supercalifragilistic'], 'a long word is not cut');
  const many = wrap(ctx, new Array(40).fill('word').join(' '), 60);
  assert.ok(many.length > 5 && many.every((l) => l.length * 6 <= 60 || !/ /.test(l)), 'every line fits or is one word');
});

test('the defaults keep what each tool already painted', () => {
  // The Text tool never drew a background; its shared style group said it did.
  assert.strictEqual(DRAW_SPEC.text.style.find((f) => f.k === 'showBg').def, false);
  for (const t of ['note', 'callout', 'balloon', 'plabel'])
    assert.strictEqual(DRAW_SPEC[t].style.find((f) => f.k === 'showBg').def, true, t);
  // A note's background follows the THEME, which no fixed spec value can do, so the
  // painter asks what the reader actually chose and keeps its own default otherwise.
  for (const t of ['text', 'note', 'callout', 'balloon'])
    assert.match(cases[t], /drawOptSet\(d, ?'bgColor'\) \|\| CHART_NOTE_BG\(\)/, t + ' lost its theme-aware background');
  const set = fn('drawOptSet');
  assert.match(set, /const bag = Object\.assign\(\{\}, d\.opts, d\.style, d\.vis\);/);
  assert.match(set, /return bag\[key\];/, 'drawOptSet must not fall back to the spec');
  assert.strictEqual(new Function(set + '\nreturn drawOptSet;')()({ style: {} }, 'bgColor'), undefined);
  assert.strictEqual(new Function(set + '\nreturn drawOptSet;')()({ style: { bgColor: '#123456' } }, 'bgColor'), '#123456');
});

test('a price label can tag the price axis, which its own clip forbids', () => {
  // Drawings paint inside a clip on the plot box, so one that wants the gutter has to
  // leave the tag for after the clip is released.
  assert.match(PAGE, /const _drawAxisTags = \[\];/);
  assert.match(cases.plabel, /if \(drawOptOf\(d, 'showOnAxis'\) !== false\) _drawAxisTags\.push\(\{ y: a\.y, text: fmt\(a\.price, 2\), color:/);
  const flush = PAGE.slice(PAGE.indexOf('// Tags a drawing asked for, in the gutter'), PAGE.indexOf('// Scales › indicator values on the price scale'));
  assert.match(flush, /if\(t\.y < 0 \|\| t\.y > priceH\) continue;/, 'a tag off the scale is still painted');
  assert.match(flush, /ctx\.fillRect\(pw\+1, Math\.round\(t\.y\)-7, AXIS_W-2, 14\);/);
  assert.match(flush, /0\.299\*c\[0\] \+ 0\.587\*c\[1\] \+ 0\.114\*c\[2\]/, 'the tag text does not pick a readable colour');
  // the flush must come after the plot clip is released, or the gutter is clipped away
  assert.ok(PAGE.indexOf('// Tags a drawing asked for, in the gutter') > PAGE.indexOf('for (const d of list) { if (d.hidden || d.pane) continue; drawOne(d, false); }'));
});
