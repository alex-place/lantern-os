'use strict';
/**
 * test/trader-crosshair-date.test.js — the crosshair's time label (QA, 2026-09-14).
 *
 * A daily, weekly or monthly bar has a date, not a clock time. The label used to print
 * "Jun 26, 12:00 AM" on a weekly bar and "Oct 1, 12:00 AM" on a monthly chart that
 * spanned 2007-2026 -- the clock was noise and the year was the missing fact.
 *
 * Run: node --test apps/lantern-garage/test/trader-crosshair-date.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const src = PAGE.slice(PAGE.indexOf('function _fmtCrossTime(ts){'), PAGE.indexOf('\n}\n', PAGE.indexOf('function _fmtCrossTime(ts){')) + 3);
const make = (tf) => new Function('_tz', '_h12', '_INTRADAY', 'chartTimeframe', src + '; return _fmtCrossTime;')(
  () => 'America/New_York', () => true, ['1m', '5m', '15m', '30m', '1h', '2h', '4h'], tf);

test('an intraday bar keeps the clock the axis reads', () => {
  assert.strictEqual(make('5m')('2026-09-11T17:11:00.000Z'), 'Sep 11, 1:11 PM');
  assert.strictEqual(make('1h')('2026-08-07T19:30:00.000Z'), 'Aug 7, 3:30 PM');
});

test('a daily or longer bar reads as a date with the year, no clock time', () => {
  assert.strictEqual(make('1d')('2026-01-09T14:30:00.000Z'), 'Jan 9, 2026');
  assert.strictEqual(make('1w')('2025-06-26T04:00:00.000Z'), 'Jun 26, 2025');
  assert.strictEqual(make('1mo')('2007-10-01T04:00:00.000Z'), 'Oct 1, 2007');
});

test('a bad timestamp is an empty label, not "Invalid Date"', () => {
  assert.strictEqual(make('1d')('not a date'), '');
  assert.strictEqual(make('5m')(undefined), '');
});
