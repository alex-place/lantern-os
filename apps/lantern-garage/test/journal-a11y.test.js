'use strict';
/**
 * test/journal-a11y.test.js — #3579.
 *
 * Semantics the automated sweep does not cover, because nothing is technically broken:
 * the page had twelve <section> elements and named none of them, which means it had no
 * regions at all — a screen reader's only landmark was an unnamed <nav>. And 39 of its 48
 * header cells had no scope, which is the difference between hearing "Realized, $544.48"
 * and hearing "$544.48".
 *
 * Run: node --test apps/lantern-garage/test/journal-a11y.test.js
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

test('every card is a NAMED region, so a screen reader can move between them (#3579)', () => {
  // An unnamed <section> is not exposed as a region at all. Twelve of them is not twelve
  // weak landmarks, it is none.
  const paint = grabFn('jpPaintCards');
  assert.match(paint, /<section class="jp-card/);
  assert.match(paint, /aria-label="' \+ jpEsc\(label\) \+ '"/, 'the section carries a name');
  assert.match(paint, /const label = \(JP_WIDGET\[id\] \|\| \{\}\)\.name \|\| id;/,
    'taken from the registry, which has a name for every card including the ones with no heading');
});

test('the name is the registry name, which exists for every card', () => {
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  const entries = [...reg.slice(0, reg.indexOf('];')).matchAll(/id: '([a-z]+)', name: '([^']+)'/g)];
  assert.ok(entries.length >= 10, 'found the registry');
  for (const [, id, name] of entries) {
    assert.ok(name && name.trim().length > 2, id + ' has a name worth announcing');
  }
});

test('every column header says it is a column header (#3579)', () => {
  /* Without scope, a screen reader reading across a row announces bare values. On the
     trade log that is nine numbers in a row with nothing to attach them to. */
  const ths = [...src.matchAll(/'<th(?![a-z])([^']*)/g)].map((m) => m[1]);
  assert.ok(ths.length >= 8, 'found the header emissions: ' + ths.length);
  const unscoped = ths.filter((attrs) => !/scope=/.test(attrs));
  assert.deepStrictEqual(unscoped, [], 'these <th> emissions carry no scope');
});

test('the heatmap keeps its row headers as row headers', () => {
  // Its left column names the weekday for the whole row, which is a different claim
  // from naming a column.
  assert.match(grabFn('jpHeatmap'), /<th scope="row">/);
});

test('every focusable control draws its own focus ring (#3579)', () => {
  /* The browser default is not nothing, but every other control here draws an accent
     ring, and one control quietly differing is the kind of thing nobody reports. */
  const classes = ['jp-chip', 'jp-sort', 'jp-linkish', 'grip', 'jp-tag-in', 'jp-note-text', 'jp-navb'];
  for (const c of classes) {
    assert.match(src, new RegExp('\\.' + c + ':focus-visible\\{[^}]*outline'), c + ' has no focus ring');
  }
});

test('the page has exactly one h1 and no heading levels are skipped', () => {
  // Checked on the rendered page too; pinned here so a new card cannot open at h3.
  const h1 = (src.match(/<h1[ >]/g) || []).length;
  assert.strictEqual(h1, 1, 'one h1');
  assert.strictEqual((src.match(/<h4[ >]/g) || []).length, 0, 'nothing jumps to h4');
  // Cards render their own heading as an h2, under the page's h1.
  const cardHeadings = (src.match(/'<h2>/g) || []).length;
  assert.ok(cardHeadings >= 6, 'the cards head themselves at h2: ' + cardHeadings);
});

test('decorative marks are hidden from screen readers, and real ones are not', () => {
  // The grip glyph, the sort arrows and the expand caret are pictures of controls that
  // already have accessible names; read aloud they are noise.
  assert.match(grabFn('jpTrades'), /aria-hidden="true"[^>]*>' \+ \(open \? '\\u25be' : '\\u25b8'\)/,
    'the expand caret is decorative');
  assert.match(grabFn('jpHeatmap'), /<span class="visually-hidden">/, 'but a cell states its figures for a reader');
});
