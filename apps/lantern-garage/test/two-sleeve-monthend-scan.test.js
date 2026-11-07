'use strict';
/**
 * two-sleeve-monthend-scan.test.js — the month-end bond book's scan (2026-11-07, draft).
 *
 * lib/two-sleeve/monthend-scan.js says what sleeve T wants in the signal shape the brains trade. Pinned on the exchange
 * calendar and on synthetic 5m sessions of TLT:
 *   - the calendar: the entry day is the session with 3 sessions left in its month (M-3), the exit day the month's last (M),
 *     holidays and 13:00 closes counted as lib/market-calendar.js says; the pairs match the replay that measured the rule;
 *   - on the entry day, once the 15:50 bar is read (15:55:20 on), the fund is BULLISH / ENTER until 16:00, and NEUTRAL
 *     before and after; between the two days every read is NEUTRAL (a held fund is held); on the exit day the same window
 *     is BEARISH / ENTER;
 *   - a 13:00 close moves the window to the 12:50 bar;
 *   - the shadow offers nothing and journals one buy row and one sale row, with the hold's return;
 *   - a window that never opens on an entry or exit day journals one row after the close; other days say nothing;
 *   - the scan worker runs it under TWO_SLEEVE_WORKER_SCAN=monthend over the sleeve's universe, as a shadow or armed.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonthEndScan, monthEndRole, monthHold, sessionsLeftInMonth, HOLD_SESSIONS } = require('../lib/two-sleeve/monthend-scan');
const { etOf } = require('../lib/market-calendar');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

const pad = (n) => String(n).padStart(2, '0');
/** The instant of an ET wall-clock time on `day` (EDT or EST, whichever the date has). */
function at(day, hh, mm, ss = 0) {
  for (const off of [4, 5]) { const ms = Date.parse(`${day}T${pad(hh + off)}:${pad(mm)}:${pad(ss)}Z`); const e = etOf(ms); if (e.day === day && e.min === hh * 60 + mm) return ms; }
  throw new Error(`no ET instant for ${day} ${hh}:${mm}`);
}
/** A session of 5m bars from 09:30 ET: `n` bars at `lvl`, the bar starting at `markMin` (ET minutes) closing at `markPx`. */
function session(day, { n = 78, lvl = 90, markMin = 950, markPx = lvl } = {}) {
  const t0 = at(day, 9, 30);
  return Array.from({ length: n }, (_, i) => { const c = 570 + 5 * i === markMin ? markPx : lvl; return { t: t0 + i * 300000, h: c + 0.02, l: c - 0.02, c }; });
}
function market(sessions) {
  const m = { now: 0, calls: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym, tf) => { m.calls++; return { bars: tf === '5m' && sym === 'TLT' ? sessions.filter((b) => b.t <= m.now).map(fmt) : [] }; };
  return m;
}
// November 2026: Thanksgiving Thursday 11-26 is closed, Friday 11-27 closes at 13:00.
const NOV = [...session('2026-11-23'), ...session('2026-11-24', { markPx: 90.5 }), ...session('2026-11-25'), ...session('2026-11-27', { n: 42 }), ...session('2026-11-30', { lvl: 91, markPx: 91 })];
const sig = (r) => r.signals.find((x) => x.symbol === 'TLT');

test('the calendar: entry with three sessions left in the month, exit on the last; holidays and 13:00 closes as the exchange says', () => {
  assert.equal(HOLD_SESSIONS, 3);
  assert.equal(monthEndRole('2026-11-24'), 'entry');
  assert.equal(monthEndRole('2026-11-30'), 'exit');
  for (const d of ['2026-11-23', '2026-11-25', '2026-11-27']) assert.equal(monthEndRole(d), null, d);
  assert.equal(monthEndRole('2026-11-26'), null, 'Thanksgiving: no session');
  assert.equal(monthEndRole('2026-11-28'), null, 'a Saturday');
  assert.equal(sessionsLeftInMonth('2026-11-24'), 3); assert.equal(sessionsLeftInMonth('2026-11-30'), 0);
  assert.deepEqual(monthHold('2026-11-10'), { entry: '2026-11-24', exit: '2026-11-30' });
  // the pairs of the replay calendar that measured the rule (laneB m3_cal.json, from SPY's real sessions); 2022-11-25 is a 13:00 close
  for (const [entry, exit] of [['2016-01-26', '2016-01-29'], ['2020-03-26', '2020-03-31'], ['2022-11-25', '2022-11-30'], ['2024-12-26', '2024-12-31'], ['2026-01-27', '2026-01-30'], ['2026-09-25', '2026-09-30'], ['2026-12-28', '2026-12-31']]) {
    assert.deepEqual(monthHold(entry), { entry, exit }, entry);
    assert.equal(monthEndRole(entry), 'entry', entry); assert.equal(monthEndRole(exit), 'exit', exit);
  }
});

test('on the entry day the 15:50 bar opens the window: a buy from 15:55:20 to 16:00, nothing before or after', async () => {
  const m = market(NOV); const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars });
  m.now = at('2026-11-24', 15, 55, 30); let r = await s.scan(m.now);
  assert.equal(r.monthend.role, 'entry'); assert.equal(r.monthend.window, 'entry'); assert.equal(r.monthend.sessions_left, 3);
  assert.equal(sig(r).direction, 'BULLISH'); assert.equal(sig(r).convergence.decision, 'ENTER'); assert.equal(sig(r).monthend, true);
  assert.equal(sig(r).decision_context.monthend_bar, '15:55'); assert.equal(sig(r).decision_context.monthend_window, 'entry');
  assert.ok(Math.abs(sig(r).entry_price - 90.5) < 1e-9, 'priced from the 15:50 bar');
  m.now = at('2026-11-24', 15, 55, 10); r = await s.scan(m.now);
  assert.equal(sig(r).direction, 'NEUTRAL', 'the 15:50 bar has not settled 10 s after it closes'); assert.match(r.monthend.reads[0].why, /entry day, outside the 15:55 window/);
  m.now = at('2026-11-24', 12, 0); r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL');
  m.now = at('2026-11-24', 16, 0, 30); r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL', 'no decision at or after 16:00'); assert.equal(r.monthend.window, null);
});

test('between the two days the book holds, and on the exit day the same window is a sell', async () => {
  const m = market(NOV); const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars });
  for (const [day, hh, mm] of [['2026-11-23', 15, 55], ['2026-11-25', 15, 55], ['2026-11-25', 10, 0], ['2026-11-27', 12, 55], ['2026-11-30', 10, 0]]) {
    m.now = at(day, hh, mm, 30); const r = await s.scan(m.now);
    assert.equal(sig(r).direction, 'NEUTRAL', `${day} ${hh}:${mm}`); assert.equal(sig(r).convergence.decision, 'SKIP');
  }
  m.now = at('2026-11-30', 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(r.monthend.role, 'exit'); assert.equal(r.monthend.window, 'exit'); assert.equal(r.monthend.sessions_left, 0);
  assert.equal(sig(r).direction, 'BEARISH'); assert.equal(sig(r).convergence.decision, 'ENTER'); assert.ok(Math.abs(sig(r).price - 91) < 1e-9);
});

test('a 13:00 close moves the window to the 12:50 bar', async () => {
  const m = market([...session('2022-11-23'), ...session('2022-11-25', { n: 42, markMin: 770, markPx: 101 })]);
  const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars });
  m.now = at('2022-11-25', 12, 55, 30); let r = await s.scan(m.now);
  assert.equal(r.monthend.role, 'entry'); assert.equal(sig(r).direction, 'BULLISH'); assert.equal(sig(r).decision_context.monthend_bar, '12:55');
  assert.ok(Math.abs(sig(r).entry_price - 101) < 1e-9, 'priced from the 12:50 bar');
  m.now = at('2022-11-25', 13, 0, 30); r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL', 'the market closed at 13:00');
  m.now = at('2022-11-25', 15, 55, 30); r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL');
});

test('the shadow offers nothing and journals the buy and the sale with the hold\'s return', async () => {
  const m = market(NOV); const rows = []; const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars, shadow: true, log: (x) => rows.push(x) });
  m.now = at('2026-11-24', 15, 55, 30); let r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL'); assert.equal(r.monthend.shadow, true);
  m.now = at('2026-11-24', 15, 56, 30); await s.scan(m.now);
  m.now = at('2026-11-30', 15, 55, 30); r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL');
  m.now = at('2026-11-30', 15, 57, 30); await s.scan(m.now);
  const buy = rows.filter((x) => x.event === 'monthend_shadow'), sale = rows.filter((x) => x.event === 'monthend_shadow_exit');
  assert.equal(buy.length, 1, 'one buy row on the entry day'); assert.equal(sale.length, 1, 'one sale row on the exit day');
  assert.equal(buy[0].day, '2026-11-24'); assert.equal(buy[0].px, 90.5); assert.equal(buy[0].exit_day, '2026-11-30'); assert.equal(buy[0].would, 'buy');
  assert.equal(sale[0].entry_day, '2026-11-24'); assert.equal(sale[0].entry_px, 90.5); assert.equal(sale[0].px, 91);
  assert.ok(Math.abs(sale[0].ret_pct - 100 * (91 / 90.5 - 1)) < 1e-3);
  assert.ok(!rows.some((x) => x.event === 'monthend_window_missed'));
});

test('a window that never opens on an entry day journals one row after the close; an ordinary day says nothing', async () => {
  const late = [...session('2026-11-24', { n: 60 }), ...session('2026-11-25', { n: 60 })];   // the feed stops at 14:25 both days
  const m = market(late); const rows = []; const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars, log: (x) => rows.push(x) });
  for (const [day] of [['2026-11-24'], ['2026-11-25']]) {
    for (const mm of [56, 57, 58]) { m.now = at(day, 15, mm, 30); const r = await s.scan(m.now); assert.equal(sig(r).direction, 'NEUTRAL'); }
    m.now = at(day, 16, 0, 30); await s.scan(m.now); m.now = at(day, 16, 5, 30); await s.scan(m.now);
  }
  const missed = rows.filter((x) => x.event === 'monthend_window_missed');
  assert.equal(missed.length, 1, 'once, and only on the entry day');
  assert.equal(missed[0].day, '2026-11-24'); assert.equal(missed[0].role, 'entry'); assert.deepEqual(missed[0].symbols, ['TLT']); assert.equal(missed[0].reads, 3);
  assert.match(missed[0].why, /nothing bought this month/);
});

test('a fund with no bars is neutral with the reason said; the guards refuse a scan that cannot work', async () => {
  const m = market([]); const s = createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars });
  m.now = at('2026-11-24', 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r).direction, 'NEUTRAL'); assert.equal(r.monthend.reads[0].why, 'no bars');
  assert.throws(() => createMonthEndScan({ symbols: ['TLT'] }), /getBars/);
  assert.throws(() => createMonthEndScan({ symbols: [], getBars: m.getBars }), /symbol/);
  assert.throws(() => createMonthEndScan({ symbols: ['TLT'], getBars: m.getBars, holdSessions: 0 }), /holdSessions/);
});

test('the worker runs it under TWO_SLEEVE_WORKER_SCAN=monthend, as a shadow or armed', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'monthend-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = (...p) => path.resolve(__dirname, '..', 'lib', ...p).replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'monthend-scan.js'), `module.exports = require(${JSON.stringify(real('two-sleeve', 'monthend-scan.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), `module.exports = require(${JSON.stringify(real('file-queue.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async (s, tf) => ({ bars: tf === '1d' ? [] : [bar(Date.now() - 86400000, 90)] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monthend-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'T', app, envFile: null, env: { TRADER_MONTHEND_SHADOW: '1' }, universe: ['TLT'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'monthend' });
  const A = new ScanWorker({ id: 'U', app, envFile: null, env: {}, universe: ['TLT'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'monthend' });
  const bad = new ScanWorker({ id: 'X', app, envFile: null, env: {}, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'monthend' });
  try {
    assert.equal(W._childEnv().TWO_SLEEVE_WORKER_SCAN, 'monthend');
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol), ['TLT']);
    assert.ok(r.signals.every((x) => x.monthend === true && x.convergence.decision === 'SKIP'), 'yesterday\'s bar only in the fake feed: nothing to do today');
    assert.ok(r.monthend && 'role' in r.monthend, 'the reply carries the day\'s role');
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'T');
    assert.ok(ready, 'the worker reported ready'); assert.equal(ready.scan, 'monthend'); assert.equal(ready.monthend, 'shadow'); assert.equal(ready.symbols, 'TLT'); assert.equal(ready.holdSessions, 3);
    assert.equal(W.status().monthend, 'shadow');
    await A.scan();
    const readyA = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'U');
    assert.ok(readyA); assert.equal(readyA.monthend, 'armed');
    await assert.rejects(bad.scan(), /exited|failed|universe/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'X' && /universe/.test(String(x.error))));
  } finally { W.stop(); A.stop(); bad.stop(); }
});
