'use strict';
/**
 * test/trader-mkt-clock.test.js — the session clock on the range strip counts to the next
 * pre-market on a weekday evening, not "wknd" (2026-10-11).
 *
 * After 20:00 ET the clock fell into its last branch, which had no countdown, and the label
 * printed "wknd" for it: every Monday-to-Thursday evening read "Closed · wknd". The next
 * edge then is tomorrow's 04:00 pre-market; only Friday night rolls into the weekend. The
 * page's own _updateMktClock runs here against a fixed clock.
 *
 * Run: node --test apps/lantern-garage/test/trader-mkt-clock.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('function _updateMktClock(){'), PAGE.indexOf('\nsetInterval(_updateMktClock'));

function clockAt(isoUtc) {
  const FIXED = Date.parse(isoUtc);
  class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED); } }
  const lab = { textContent: '', className: '' }, val = { textContent: '' };
  new Function('document', 'Date', SRC + '\n_updateMktClock();')({ getElementById: (id) => (id === 'mktClockLabel' ? lab : val) }, FixedDate);
  return lab.textContent + ' · ' + val.textContent;
}

test('a weekday evening counts to the next pre-market', () => {
  assert.ok(SRC.length > 300, '_updateMktClock found');
  assert.strictEqual(clockAt('2026-10-14T01:00:00Z'), 'Closed · 7h 00m to pre', 'Tuesday 21:00 ET read "Closed · wknd"');
  assert.strictEqual(clockAt('2026-10-13T03:59:00Z'), 'Closed · 4h 01m to pre', 'Monday 23:59 ET');
  assert.strictEqual(clockAt('2026-10-16T00:30:00Z'), 'Closed · 7h 30m to pre', 'Thursday 20:30 ET');
});

test('Friday night and the weekend are the weekend', () => {
  assert.strictEqual(clockAt('2026-10-17T01:00:00Z'), 'Closed · wknd', 'Friday 21:00 ET');
  assert.strictEqual(clockAt('2026-10-17T16:00:00Z'), 'Closed · wknd', 'Saturday');
  assert.strictEqual(clockAt('2026-10-18T23:00:00Z'), 'Closed · wknd', 'Sunday 19:00 ET');
});

test('the day\'s own phases are unchanged', () => {
  assert.strictEqual(clockAt('2026-10-12T07:00:00Z'), 'Closed · 1h 00m to pre', 'Monday 03:00 ET');
  assert.strictEqual(clockAt('2026-10-14T12:00:00Z'), 'Pre-mkt · 1h 30m to open', 'Wednesday 08:00 ET');
  assert.strictEqual(clockAt('2026-10-14T14:00:00Z'), 'Open · 6h 00m to close', 'Wednesday 10:00 ET');
  assert.strictEqual(clockAt('2026-10-14T21:00:00Z'), 'After-hrs · 3h 00m left', 'Wednesday 17:00 ET');
});
