'use strict';
/**
 * test/journal-day-tiles.test.js — #3538.
 *
 * The journal's day tiles (Current streak, Day win %) must read the same measure as
 * the P&L calendar under them. The calendar shows the account's change per session
 * by default (#3517); the tiles still counted booked days. So on 2026-09-11 the
 * calendar showed seven green sessions in a row and the tile said "2 winning days".
 *
 * These run the REAL functions extracted from journal.html, not a mirror of them.
 * Run: node --test apps/lantern-garage/test/journal-day-tiles.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

// A top-level function declaration, from its first line to the brace that closes it.
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
// A top-level const, up to the next top-level declaration or comment.
const grabConst = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const CODE = ['jpEsc', 'jpUsd', 'jpPct', 'jpSign'].map(grabConst).join('\n')
  + '\n' + ['jpDayStats', 'jpDaySeries', 'jpKpis'].map(grabFn).join('\n');
// jpCalMode is the page's global (the Account / Booked toggle); each build pins it.
const build = (mode) => new Function('jpCalMode', CODE + '\nreturn { jpDayStats, jpDaySeries, jpKpis };')(mode);

// Shaped like the race box on Fri 2026-09-11. Booked: the last two booked days won, the
// one before lost. Account: 9/1 red, then every session green through today (live).
const DAILY = [
  { date: '2026-08-20', pnl: -120 }, { date: '2026-08-25', pnl: 60 }, { date: '2026-09-01', pnl: -300 },
  { date: '2026-09-04', pnl: 150 }, { date: '2026-09-08', pnl: -40 }, { date: '2026-09-10', pnl: 520 },
  { date: '2026-09-11', pnl: 410 },
];
const ACCT = {
  '2026-08-10': 99,   // before the journal's first booked day: outside the window
  '2026-08-20': -80, '2026-08-21': 40, '2026-09-01': -471.75, '2026-09-02': 294.13, '2026-09-03': 67.26,
  '2026-09-04': 356.57, '2026-09-08': 332.13, '2026-09-09': 183.46, '2026-09-10': 78.24,
};
const LIVE = { date: '2026-09-11', pnl: 292.37 };
const STATS = { totalRealized: 202.88, trades: 43, winRate: 55.8, riskExitWinRate: 50, profitFactor: 1.09, avgWin: 102.55, avgLoss: -118.86, expectancy: 4.72 };
const BOOK = { maxDrawdown: { amount: 1003.95 } };
const tile = (html, key) => {
  const m = html.match(new RegExp('<div class="k">' + key + '</div><div class="v[^"]*">([^<]*)</div><div class="s">([^<]*)</div>'));
  assert.ok(m, 'tile not found: ' + key);
  return { v: m[1], s: m[2] };
};

test('Account view: the streak is the calendar\'s run of green sessions, today\'s live figure included', () => {
  const f = build('account');
  const ser = f.jpDaySeries(DAILY, LIVE, ACCT);
  assert.strictEqual(ser.mode, 'account');
  assert.strictEqual(ser.days[0].date, '2026-08-20', 'starts at the journal\'s first booked day');
  assert.strictEqual(ser.days[ser.days.length - 1].date, '2026-09-11', 'ends with today, live');
  const ds = f.jpDayStats(ser.days);
  assert.deepStrictEqual([ds.streak, ds.dir, ds.tradingDays], [7, 1, 10]);
  assert.strictEqual(Math.round(ds.dayWinRate * 10) / 10, 80);
});

test('Booked view: the streak counts closed-trade days, exactly as before', () => {
  const f = build('booked');
  const ser = f.jpDaySeries(DAILY, LIVE, ACCT);
  assert.strictEqual(ser.mode, 'booked');
  assert.strictEqual(ser.days, DAILY);
  const ds = f.jpDayStats(ser.days);
  assert.deepStrictEqual([ds.streak, ds.dir, ds.tradingDays], [2, 1, 7]);
});

test('no account series (the demo book): the tiles stay booked even in Account mode', () => {
  const ser = build('account').jpDaySeries(DAILY, null, null);
  assert.strictEqual(ser.mode, 'booked');
});

test('a flat "today so far" does not break the run', () => {
  const f = build('account');
  const ds = f.jpDayStats(f.jpDaySeries(DAILY, { date: '2026-09-11', pnl: 0 }, ACCT).days);
  assert.strictEqual(ds.streak, 6, '9/2 through 9/10; a flat today is left out');
});

test('the tiles name the measure they show', () => {
  for (const [mode, streak, streakSub, daySub] of [
    ['account', '7', '7 green sessions', '10 sessions'],
    ['booked', '2', '2 winning days', '7 trading days'],
  ]) {
    const f = build(mode);
    const ser = f.jpDaySeries(DAILY, LIVE, ACCT);
    const html = f.jpKpis(STATS, BOOK, Object.assign(f.jpDayStats(ser.days), { mode: ser.mode }));
    assert.deepStrictEqual(tile(html, 'Current streak'), { v: streak, s: streakSub }, mode);
    assert.strictEqual(tile(html, 'Day win %').s, daySub, mode);
  }
});

test('jpRender feeds the tiles the calendar\'s series', () => {
  const render = grabFn('jpRender');
  assert.match(render, /const dsr = jpDaySeries\(daily, liveToday, acct\);/);
  assert.match(render, /const ds = Object\.assign\(jpDayStats\(dsr\.days\), \{ mode: dsr\.mode \}\);/);
  assert.doesNotMatch(render, /jpDayStats\(daily\)/, 'the booked-only call is gone');
});
