'use strict';
/**
 * test/journal-disclosures.test.js — #3552.
 *
 * The record's disclosures say which rows were collapsed, which attempts were thrown out,
 * and which closes were priced off a mark rather than a fill. trader_journal is required
 * to relay them ("must be passed on, not hidden"), so the page owes the reader the same
 * words — and for a while it owed them "[object Object]".
 *
 * Run: node --test apps/lantern-garage/test/journal-disclosures.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '('));
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

const jpDisclosures = new Function(grabFn('jpDisclosures') + '\nreturn jpDisclosures;')();

// The shape lib/track-record.js actually builds.
const REAL = { duplicateExitsCollapsed: 0, failedAttemptsExcluded: 0, estimatedTrades: 0 };

test('the object never reaches the reader as "[object Object]"', () => {
  for (const d of [REAL, { duplicateExitsCollapsed: 3, failedAttemptsExcluded: 2, estimatedTrades: 1 }, {}, { nonsense: 1 }]) {
    assert.doesNotMatch(jpDisclosures(d), /\[object Object\]/, JSON.stringify(d));
  }
});

test('nothing to disclose says nothing at all', () => {
  assert.strictEqual(jpDisclosures(REAL), '', 'a row of zeros is noise, not honesty');
  assert.strictEqual(jpDisclosures(null), '');
  assert.strictEqual(jpDisclosures(undefined), '');
  assert.strictEqual(jpDisclosures({}), '');
});

test('each count is stated in words, and only when it happened', () => {
  const dup = jpDisclosures({ duplicateExitsCollapsed: 4, failedAttemptsExcluded: 0, estimatedTrades: 0 });
  assert.match(dup, /4 re-decision rows/);
  assert.doesNotMatch(dup, /rejected|mark/, 'a zero count is not mentioned');

  const bad = jpDisclosures({ failedAttemptsExcluded: 2 });
  assert.match(bad, /2 broker-rejected attempts/);
  assert.match(bad, /realized nothing/, 'and says why excluding them is right');

  const est = jpDisclosures({ estimatedTrades: 1 });
  assert.match(est, /1 external close\b/, 'one close, not "1 external closes"');
  assert.match(est, /last observed mark/);
});

test('all three read as one sentence', () => {
  const all = jpDisclosures({ duplicateExitsCollapsed: 1, failedAttemptsExcluded: 5, estimatedTrades: 2 });
  assert.match(all, /^How these figures were counted: /);
  assert.match(all, /1 re-decision row\b/, 'singular');
  assert.match(all, /5 broker-rejected attempts/);
  assert.match(all, /2 external closes/);
  assert.strictEqual((all.match(/;/g) || []).length, 2, 'three clauses, two separators');
  assert.ok(all.endsWith('.'));
});

test('a negative or unparseable count is treated as nothing to say', () => {
  assert.strictEqual(jpDisclosures({ duplicateExitsCollapsed: -3, failedAttemptsExcluded: NaN, estimatedTrades: 'lots' }), '');
});

test('an older record carrying prose is passed through as prose', () => {
  assert.strictEqual(jpDisclosures('  Figures exclude paper fills.  '), 'Figures exclude paper fills.');
});

test('the page renders it escaped, and only when there is something to say', () => {
  const render = grabFn('jpRender');
  assert.match(render, /jpDisclosures\(book\.disclosures\)/);
  assert.match(render, /jpEsc\(disclosed\)/, 'escaped like every other string from the record');
  assert.doesNotMatch(render, /String\(book\.disclosures\)/, 'the bug itself is gone');
});
