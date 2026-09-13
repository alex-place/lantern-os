'use strict';
/**
 * test/journal-polish.test.js — #3575.
 *
 * Three faults that all have the same shape: layout rules written when a card's width was
 * the window's width, plus chrome that assumed a card had no title of its own. Once the
 * journal had twelve cards and a reader could resize them (#3565), each one showed.
 *
 * Run: node --test apps/lantern-garage/test/journal-polish.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
  assert.ok(i >= 0, 'function not found: ' + name);
  let depth = 0, started = false;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};

// ── the KPI band ──────────────────────────────────────────────────────────────
test('every column count the KPI band uses divides the number of tiles (#3575)', () => {
  /* auto-fit packed as many 150px tiles as fitted, which at a common desktop width was
     six — so eight tiles rendered as a row of six and an orphan pair against a half-empty
     row. Five, six and seven do not divide eight; four and eight do. */
  const tileCount = (grabFn('jpKpis').match(/\+ card\(/g) || []).length;
  assert.ok(tileCount > 0, 'found the tiles');

  const band = src.slice(src.indexOf('#jpKpis{container-type'), src.indexOf('#jpKpis{container-type') + 700);
  const counts = [...band.matchAll(/grid-template-columns:repeat\((\d+),/g)].map((m) => Number(m[1]));
  assert.ok(counts.length >= 2, 'the band declares explicit column counts, not auto-fit: ' + counts);
  for (const n of counts) {
    assert.strictEqual(tileCount % n, 0, n + ' columns would orphan ' + (tileCount % n) + ' of ' + tileCount + ' tiles');
  }
  assert.doesNotMatch(band, /auto-fit/, 'auto-fit is what produced the orphans');
});

test('the KPI band measures the card, not the window (#3575)', () => {
  // A reader can make Key figures half width on a wide screen; the tiles have to respond
  // to that, and a viewport query cannot see it.
  assert.match(src, /#jpKpis\{container-type:inline-size\}/);
  const band = src.slice(src.indexOf('#jpKpis{container-type'), src.indexOf('#jpKpis{container-type') + 700);
  assert.match(band, /@container \(min-width:\d+px\)\{ \.jp-kpis/);
  assert.doesNotMatch(band, /@media[^}]*\.jp-kpis\{grid-template-columns/);
});

// ── the calendar ──────────────────────────────────────────────────────────────
test('the calendar\'s narrow layout keys off its card, not the window (#3575)', () => {
  // A six-column calendar on a 1400px screen kept the full figures and truncated them to
  // "-$198...", because the viewport was nowhere near the breakpoint.
  assert.match(src, /#jpCalCard\{container-type:inline-size\}/);
  const i = src.indexOf('#jpCalCard{container-type');
  const block = src.slice(i, i + 900);
  assert.match(block, /@container \(max-width:560px\)/);
  assert.match(block, /\.jp-day \.p-full\{display:none\}/, 'the short figure swaps in inside the container query');
  assert.match(block, /\.jp-week\{display:none\}/, 'and the week column goes with it');
});

test('the page-level rule stays a page-level rule', () => {
  // .jp-shell is the page gutter, not the calendar — it must not move into the card's
  // container query, where it would fire on a narrow CARD and re-pad a wide page.
  const i = src.indexOf('#jpCalCard{container-type');
  const container = src.slice(i, src.indexOf('@media (max-width:560px)', i));
  assert.doesNotMatch(container, /\.jp-shell/);
  assert.match(src.slice(src.indexOf('@media (max-width:560px)', i)), /^@media \(max-width:560px\)\{\s*\.jp-shell/);
});

// ── the edit bar ──────────────────────────────────────────────────────────────
const bar = new Function(
  'const jpEdit = true;'
  + '\nconst JP_COLS = 12, JP_ROW = 40;'
  + '\nconst jpEsc = (s) => String(s == null ? "" : s).replace(/[&<>"\']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]));'
  + '\nconst JP_WIDGET = { calendar: { name: "P&L calendar" }, kpis: { name: "Key figures" } };'
  + '\n' + grabFn('jpCardBar') + '\nreturn jpCardBar;')();

test('a card that prints its own heading is not named twice (#3575)', () => {
  // Ten of the twelve cards printed their name in the bar and again as their own <h2>
  // the moment edit mode opened.
  const titled = bar('calendar', 6, null, true);
  // The VISIBLE name is what must not repeat. The name still belongs in the aria-labels:
  // a screen reader has no <h2> in earshot when it lands on the grip.
  assert.match(titled, /<span class="name"><\/span>/, 'the visible name is empty, and the spacer remains');
  assert.match(titled, /aria-label="Move or resize P&amp;L calendar/, 'the grip still says which card it is');
  assert.match(titled, /aria-label="Hide P&amp;L calendar"/, 'and so does the hide button');
});

test('a card with no heading of its own is still named', () => {
  const untitled = bar('kpis', 12, null, false);
  assert.match(untitled, /<span class="name">Key figures<\/span>/);
});

test('the bar is told whether the card is titled, from the card\'s own markup', () => {
  const paint = grabFn('jpPaintCards');
  assert.match(paint, /jpCardBar\(id, span, h, \/<h2\[ >\]\/\.test\(body\)\)/,
    'decided from what the card actually renders, not from a list that would drift');
});
