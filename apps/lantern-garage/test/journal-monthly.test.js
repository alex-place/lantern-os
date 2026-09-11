'use strict';
/**
 * test/journal-monthly.test.js — #3548.
 *
 * Months against each other. The arithmetic that matters is the drawdown: it is the worst
 * run-down INSIDE a month, which is not the month's loss and not the record's drawdown —
 * a month can finish up and still have hurt on the way.
 *
 * Run: node --test apps/lantern-garage/test/journal-monthly.test.js
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
const grabDecl = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const CODE = [
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpSign'),
  'let jpMonth = null;',
  grabFn('jpMonthRows'), grabFn('jpMonthLabel'), grabFn('jpShortDate'), grabFn('jpMonthly'),
].join('\n');
const P = new Function(CODE
  + '\nreturn { jpMonthRows, jpMonthLabel, jpShortDate, jpMonthly, setMonth: (m) => { jpMonth = m; } };')();

const d = (date, pnl) => ({ date, pnl });

test('days are grouped by month, newest month first', () => {
  const rows = P.jpMonthRows([d('2026-07-30', 10), d('2026-08-03', 20), d('2026-09-01', 5)]);
  assert.deepStrictEqual(rows.map((r) => r.month), ['2026-09', '2026-08', '2026-07']);
});

test('a day with no P&L is not a trading day', () => {
  const rows = P.jpMonthRows([d('2026-08-03', 0), d('2026-08-04', 100), d('2026-08-05', 0)]);
  assert.strictEqual(rows[0].days, 1, 'flat days do not count as traded');
  assert.strictEqual(rows[0].pnl, 100);
  assert.strictEqual(rows[0].winRate, 100);
});

test('the month total, its best day and its worst day', () => {
  const rows = P.jpMonthRows([d('2026-08-03', 100), d('2026-08-04', -40), d('2026-08-05', 250), d('2026-08-06', -10)]);
  const m = rows[0];
  assert.strictEqual(m.pnl, 300);
  assert.strictEqual(m.days, 4);
  assert.strictEqual(m.winRate, 50);
  assert.deepStrictEqual([m.best.date, m.best.pnl], ['2026-08-05', 250]);
  assert.deepStrictEqual([m.worst.date, m.worst.pnl], ['2026-08-04', -40]);
});

test('drawdown is the worst run-down INSIDE the month, not the month\'s result', () => {
  // Up 100, down 300, up 400: the month finishes +200 having been 300 under its own high.
  const rows = P.jpMonthRows([d('2026-08-03', 100), d('2026-08-04', -300), d('2026-08-05', 400)]);
  assert.strictEqual(rows[0].pnl, 200, 'a green month');
  assert.strictEqual(rows[0].drawdown, 300, 'that still hurt on the way');
});

test('a month that only ever went up has no drawdown', () => {
  const rows = P.jpMonthRows([d('2026-08-03', 10), d('2026-08-04', 20)]);
  assert.strictEqual(rows[0].drawdown, 0);
});

test('a drawdown is measured from the month\'s own start, not from a running total', () => {
  // If the previous month's cumulative leaked in, August would show a drawdown it did not have.
  const rows = P.jpMonthRows([d('2026-07-30', 1000), d('2026-08-03', -50), d('2026-08-04', 80)]);
  const aug = rows.find((r) => r.month === '2026-08');
  assert.strictEqual(aug.pnl, 30);
  assert.strictEqual(aug.drawdown, 50, 'the month opens flat, so the first red day IS the run-down');
});

test('junk dates are skipped rather than grouped into a nonsense month', () => {
  const rows = P.jpMonthRows([d('2026-08-03', 10), d('not-a-date', 999), { pnl: 5 }, null, d('20260804', 7)]);
  assert.deepStrictEqual(rows.map((r) => r.month), ['2026-08']);
  assert.strictEqual(rows[0].pnl, 10, 'and their P&L does not leak in');
});

test('no days at all is an empty list, not a crash', () => {
  for (const bad of [null, undefined, []]) assert.deepStrictEqual(P.jpMonthRows(bad), [], String(bad));
});

test('the month label is built from the numbers, so no timezone can shift it', () => {
  assert.match(P.jpMonthLabel('2026-01'), /Jan/);
  assert.match(P.jpMonthLabel('2026-12'), /Dec/);
  assert.match(P.jpMonthLabel('2026-01'), /2026/);
  assert.strictEqual(P.jpMonthLabel('rubbish'), 'rubbish', 'and something unparseable is shown as-is');
});

test('the best and worst day name a date, not a bare number', () => {
  // It read "$154.27 04", which looks like a count sitting next to an amount.
  assert.match(P.jpShortDate('2026-09-04'), /Sep/);
  assert.match(P.jpShortDate('2026-09-04'), /\b4\b/);
  assert.strictEqual(P.jpShortDate('2026-01-01').includes('2026'), false, 'the row already says the year');
  assert.strictEqual(P.jpShortDate('nonsense'), 'nonsense');
  const html = P.jpMonthly({ mode: 'booked', days: [d('2026-09-04', 154.27), d('2026-09-09', -112.96)] });
  assert.match(html, /Sep 4/);
  assert.match(html, /Sep 9/);
});

test('the table names the measure it is showing', () => {
  const days = [d('2026-08-03', 100)];
  assert.match(P.jpMonthly({ mode: 'account', days }), /Sessions/);
  assert.match(P.jpMonthly({ mode: 'account', days }), /Every session the account reported/);
  assert.match(P.jpMonthly({ mode: 'booked', days }), /Trading days/);
  assert.match(P.jpMonthly({ mode: 'booked', days }), /books on the day it closes/);
});

test('the month the calendar is showing is marked in the table', () => {
  const days = [d('2026-08-03', 100), d('2026-09-02', 50)];
  P.setMonth('2026-08');
  const html = P.jpMonthly({ mode: 'booked', days });
  assert.strictEqual((html.match(/<tr class="on">/g) || []).length, 1, 'exactly one row is the current one');
  P.setMonth(null);
  assert.doesNotMatch(P.jpMonthly({ mode: 'booked', days }), /<tr class="on">/);
});

test('an empty record says so instead of drawing an empty table', () => {
  const html = P.jpMonthly({ mode: 'booked', days: [] });
  assert.match(html, /Nothing to summarise by month yet/);
  assert.doesNotMatch(html, /<table/);
});

test('the P&L bar is scaled against the biggest month and never exceeds it', () => {
  const days = [d('2026-07-01', 1000), d('2026-08-01', 250), d('2026-09-01', -500)];
  const html = P.jpMonthly({ mode: 'booked', days });
  const pcts = [...html.matchAll(/transparent\) (\d+)%/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(pcts, [50, 25, 100], 'newest first: -500, 250, 1000 against a 1000 ceiling');
  assert.ok(pcts.every((p) => p <= 100));
});

test('picking a month moves the calendar and fetches nothing', () => {
  const go = grabFn('jpGotoMonth');
  assert.match(go, /jpPaintCalendar\(\)/);
  assert.match(go, /jpCalMonths\(jpData\)/, 'a month the calendar cannot show is refused');
  assert.doesNotMatch(go, /fetch\(/, 'the calendar already holds every day');
  assert.doesNotMatch(go, /jpLoad\(/);
});

test('changing the measure repaints the monthly table too, so the two cannot disagree', () => {
  const paint = grabFn('jpPaintCalendar');
  assert.match(paint, /jpMonthlyCard/);
  assert.match(paint, /jpMonthly\(dsr\)/, 'from the same series the tiles and calendar use');
});

test('the card is in the arrangement registry', () => {
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  assert.match(reg.slice(0, reg.indexOf(']')), /id: 'monthly'/);
  assert.match(grabFn('jpCardBody'), /id === 'monthly'/);
});
