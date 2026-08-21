'use strict';
/**
 * footer-tiles.test.js — the account footer's tiles mean what their labels say
 * (#3409).
 *
 * The row has TWO bases and the history of forcing one on the whole row is two
 * bugs: 2026-08-13 (whole-lot Realized inflated the day) and 2026-08-22 (the
 * Unrealized tile wired to the DAY-basis move — +$1,658 above a positions
 * table summing -$679, and mirroring Day P&L exactly every morning, since
 * realized 0 makes day = unrealized-move).
 *
 * The contract, pinned against the SHIPPED source because renderTpSummary is
 * page-bound and cannot run headless:
 *   Realized, Day  → TODAY (ledger basis); Day's tooltip carries the
 *                    decomposition so the arithmetic stays visible
 *   Unrealized     → SINCE ENTRY, reconciling with the table column below it
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');
const seg = src.slice(src.indexOf('function _dayPnlTip'), src.indexOf('// #2437'));

test('the footer summary block parses as JavaScript', () => {
  assert.doesNotThrow(() => new Function(seg));
});

test('the Unrealized tile binds SINCE-ENTRY unrealized, never the day-basis move', () => {
  assert.match(seg, /cell\('Unrealized P&L', signed\(a\.unrealized\)/,
    'the tile must render a.unrealized (the table sum)');
  assert.ok(!/cell\(a\.unrealized_today != null \? 'Unrealized/.test(seg),
    'the 08-22 conditional wiring must not return');
});

test('the Day P&L tooltip carries the Realized + open-move decomposition', () => {
  assert.match(seg, /decomp/, 'decomposition variable present');
  assert.match(seg, /realized_today != null && a\.unrealized_today != null/,
    'decomposition is guarded on both fields being present');
});

test('no tile claims the row sums any more — that promise is what broke twice', () => {
  assert.ok(!/Realized \+ Unrealized above add up/.test(seg),
    'the row-sums claim must stay dead');
});
