'use strict';
/**
 * test/journal-import-ui.test.js — #3557.
 *
 * The empty state is the whole point of this change: it used to tell a manual trader that
 * the page would fill in "as soon as a position closes", which for them was never going
 * to happen. What is pinned here is that it no longer promises that, that the offer only
 * appears when it can actually do something, and that "nothing new" and "nothing at all"
 * are not reported as the same outcome.
 *
 * Run: node --test apps/lantern-garage/test/journal-import-ui.test.js
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

test('the empty state no longer promises that waiting will fill the page in', () => {
  const render = grabFn('jpRender');
  assert.doesNotMatch(render, /As soon as a position closes/,
    'that was true only for the autopilot, which is the $200 plan');
  assert.match(render, /No trades on record yet/);
  assert.match(render, /trades you place yourself through a connected broker/,
    'it names the path that applies to most readers');
  assert.match(render, /id="jpImport"/, 'and gives the offer somewhere to go');
});

test('the offer only appears when it can actually do something', () => {
  const paint = grabFn('jpPaintImportOffer');
  assert.match(paint, /st\.available/);
  assert.match(paint, /Connect a broker in Settings/, 'and says what to do when it cannot');
  assert.match(paint, /Sign in/, 'and distinguishes a guest from a signed-in reader with no broker');
  assert.match(paint, /Running it twice changes nothing/, 'the reader is told it is safe to repeat');
});

test('"nothing new" and "nothing at all" are different sentences', () => {
  // Reporting an up-to-date journal as "no trades found" would read as data loss.
  const run = grabFn('jpRunImport');
  assert.match(run, /Already up to date/);
  assert.match(run, /No trades found at your broker/);
  assert.match(run, /still open/, 'and an unfinished position is neither of those');
});

test('a failed import says nothing was changed', () => {
  const run = grabFn('jpRunImport');
  assert.match(run, /Nothing was changed/);
  assert.match(run, /no_broker/, 'and a missing broker gets its own message');
});

test('the record is re-read only when it actually changed', () => {
  const run = grabFn('jpRunImport');
  const reload = run.slice(run.indexOf('if (!out.imported)'));
  assert.match(run, /jpLoad\(true\)/, 'importing new trades changes the record, so it is re-read');
  assert.ok(reload.indexOf('return;') < reload.indexOf('jpLoad(true)'),
    'but an import that changed nothing returns before re-reading');
});

test('the button is hidden until the check says otherwise', () => {
  assert.match(src, /id="jpImportBtn" hidden/, 'no button offered before we know it would work');
  assert.match(grabFn('jpImportCheck'), /btn\.hidden = !\(jpImportState && jpImportState\.available\)/);
  assert.match(grabFn('jpImportCheck'), /catch \(_e\) \{ return; \}/, 'offline leaves it hidden rather than broken');
});

test('the import is checked on load, and asks the server nothing about other users', () => {
  assert.match(src, /jpImportCheck\(\);\s*\/\/ can this reader/, 'wired into boot');
  const check = grabFn('jpImportCheck');
  assert.match(check, /credentials: 'same-origin'/);
  assert.doesNotMatch(check + grabFn('jpRunImport'), /user=|userId/,
    'the reader is whoever the session says — never a parameter');
});
