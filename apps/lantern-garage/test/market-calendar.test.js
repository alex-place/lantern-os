'use strict';
/**
 * market-calendar.test.js — the NYSE session calendar (2026-10-26).
 *
 * Every trading clock assumed a weekday 09:30-16:00 session. On a weekday holiday the runner and the server's autoscan
 * called the market open, and on a 13:00 early close the scans read the Yahoo feed's after-hours prints (13:00-15:55)
 * as session bars while the 15:45-15:55 decisions and the de-carry / eod_flat / max_hold rules fired after the close.
 * Pinned here:
 *   - the rules reproduce the replay caches exactly: the 102 weekdays with no SPY session from 2016-01-04 to 2026-10-23
 *     are the closures, and the 21 sessions whose after-13:00 bars thin out to after-hours prints are the 13:00 closes;
 *   - 2026-27 by rule; regular and extended hours on a full day, a holiday and an early close; sessions counted across
 *     holidays; unscheduled closures from the environment;
 *   - session bars stop at 13:00 on an early close; close-IBS decides on the 12:45/12:50 bars of a Thursday early close
 *     and the overnight book buys at the 12:50 bar, and neither treats the after-hours bars that follow as a window;
 *   - the runner, the server's autoscan, the order router, the market status and the leg read the calendar.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cal = require('../lib/market-calendar');
const { sessionBars } = require('../lib/trend-shadow');
const { createCloseIbsScan } = require('../lib/two-sleeve/closeibs-scan');
const { createOvernightScan } = require('../lib/two-sleeve/overnight-scan');

// From the replay caches (C:/dev/replay-cache, SPY 5m 2016-01-04..2026-10-23): every weekday with no session ...
const CLOSED = `2016-01-18 2016-02-15 2016-03-25 2016-05-30 2016-07-04 2016-09-05 2016-11-24 2016-12-26 2017-01-02 2017-01-16
2017-02-20 2017-04-14 2017-05-29 2017-07-04 2017-09-04 2017-11-23 2017-12-25 2018-01-01 2018-01-15 2018-02-19 2018-03-30
2018-05-28 2018-07-04 2018-09-03 2018-11-22 2018-12-05 2018-12-25 2019-01-01 2019-01-21 2019-02-18 2019-04-19 2019-05-27
2019-07-04 2019-09-02 2019-11-28 2019-12-25 2020-01-01 2020-01-20 2020-02-17 2020-04-10 2020-05-25 2020-07-03 2020-09-07
2020-11-26 2020-12-25 2021-01-01 2021-01-18 2021-02-15 2021-04-02 2021-05-31 2021-07-05 2021-09-06 2021-11-25 2021-12-24
2022-01-17 2022-02-21 2022-04-15 2022-05-30 2022-06-20 2022-07-04 2022-09-05 2022-11-24 2022-12-26 2023-01-02 2023-01-16
2023-02-20 2023-04-07 2023-05-29 2023-06-19 2023-07-04 2023-09-04 2023-11-23 2023-12-25 2024-01-01 2024-01-15 2024-02-19
2024-03-29 2024-05-27 2024-06-19 2024-07-04 2024-09-02 2024-11-28 2024-12-25 2025-01-01 2025-01-09 2025-01-20 2025-02-17
2025-04-18 2025-05-26 2025-06-19 2025-07-04 2025-09-01 2025-11-27 2025-12-25 2026-01-01 2026-01-19 2026-02-16 2026-04-03
2026-05-25 2026-06-19 2026-07-03 2026-09-07`.split(/\s+/);
// ... and every session whose after-13:00 bars thin out to after-hours prints (median 1-4 bars a name vs 36; KRE XBI ITB
// XRT XME EWW COPX), i.e. a 13:00 close.
const EARLY = `2016-11-25 2017-07-03 2017-11-24 2018-07-03 2018-11-23 2018-12-24 2019-07-03 2019-11-29 2019-12-24 2020-11-27
2020-12-24 2021-11-26 2022-11-25 2023-07-03 2023-11-24 2024-07-03 2024-11-29 2024-12-24 2025-07-03 2025-11-28
2025-12-24`.split(/\s+/);
const days = (from, to) => { const out = []; for (let d = from; d <= to; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) out.push(d); return out; };
const weekdays = (from, to) => days(from, to).filter((d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5; });
// ET wall time -> ms; late November and December are EST (UTC-5), September EDT (UTC-4).
const est = (day, hh, mm, ss = 0) => Date.parse(`${day}T00:00:00Z`) + (((hh + 5) * 60 + mm) * 60 + ss) * 1000;
const edt = (day, hh, mm, ss = 0) => Date.parse(`${day}T00:00:00Z`) + (((hh + 4) * 60 + mm) * 60 + ss) * 1000;

test('the rules reproduce every weekday closure and every 13:00 close in the replay caches, 2016-2026', () => {
  assert.equal(CLOSED.length, 102); assert.equal(EARLY.length, 21);
  const w = weekdays('2016-01-04', '2026-10-23');
  assert.deepEqual(w.filter((d) => !cal.isTradingDay(d)), CLOSED, 'the closures');
  assert.deepEqual(w.filter((d) => cal.closeMin(d) === cal.EARLY_CLOSE_MIN), EARLY, 'the 13:00 closes');
  assert.equal(cal.closeMin('2026-10-23'), 960, 'a full day closes at 16:00');
  assert.equal(cal.closeMin('2026-10-24'), null, 'a Saturday is no session');
});

test('2026-27 by rule: Thanksgiving, its 13:00 Friday, Christmas Eve and the observed holidays', () => {
  assert.equal(cal.closeMin('2026-11-26'), null, 'Thanksgiving');
  assert.equal(cal.closeMin('2026-11-27'), 780, 'the Friday after, 13:00');
  assert.equal(cal.closeMin('2026-12-24'), 780, 'Christmas Eve on a Thursday, 13:00');
  assert.equal(cal.closeMin('2026-12-25'), null, 'Christmas');
  assert.equal(cal.closeMin('2026-07-02'), 960, 'no 13:00 close when July 3 is the observed holiday');
  const y27 = weekdays('2027-01-01', '2027-12-31');
  assert.deepEqual(y27.filter((d) => !cal.isTradingDay(d)), ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'], 'Juneteenth on a Saturday closes Friday, July 4 on a Sunday Monday, Christmas on a Saturday Friday');
  assert.deepEqual(y27.filter((d) => cal.closeMin(d) === 780), ['2027-11-26'], 'July 3 is a Saturday and December 24 the observed holiday');
  assert.equal(cal.isTradingDay('2027-12-31'), true, 'New Year 2028 is a Saturday: the Friday before stays open (a year end)');
  assert.deepEqual(cal.easter(2026), [4, 5]); assert.deepEqual(cal.easter(2027), [3, 28]);
});

test('regular and extended hours on a full day, a holiday and a 13:00 close', () => {
  const full = '2026-11-25';
  assert.equal(cal.isRegularHours(est(full, 9, 29)), false); assert.equal(cal.isRegularHours(est(full, 9, 30)), true);
  assert.equal(cal.isRegularHours(est(full, 15, 59)), true); assert.equal(cal.isRegularHours(est(full, 16, 0)), false);
  assert.equal(cal.isExtendedHours(est(full, 4, 0)), true); assert.equal(cal.isExtendedHours(est(full, 16, 0)), true);
  assert.equal(cal.isExtendedHours(est(full, 19, 59)), true); assert.equal(cal.isExtendedHours(est(full, 20, 0)), false);
  for (const [h, m] of [[4, 0], [9, 30], [12, 0], [15, 55], [17, 0]]) {
    assert.equal(cal.isRegularHours(est('2026-11-26', h, m)), false, `Thanksgiving ${h}:${m} is not a session`);
    assert.equal(cal.isExtendedHours(est('2026-11-26', h, m)), false, `Thanksgiving ${h}:${m} has no extended session`);
  }
  const half = '2026-11-27';
  assert.equal(cal.isRegularHours(est(half, 12, 59)), true); assert.equal(cal.isRegularHours(est(half, 13, 0)), false);
  assert.equal(cal.isRegularHours(est(half, 15, 55)), false, 'the old clock called 15:55 open');
  assert.equal(cal.isExtendedHours(est(half, 13, 0)), true); assert.equal(cal.isExtendedHours(est(half, 16, 59)), true);
  assert.equal(cal.isExtendedHours(est(half, 17, 0)), false, 'the after-hours session of a 13:00 close ends at 17:00');
  assert.equal(cal.closeOffset(half), 180); assert.equal(cal.closeOffset(full), 0); assert.equal(cal.closeOffset('2026-11-26'), 0);
  assert.equal(cal.inRegularSession(half, 775), true, 'the 12:55 bar'); assert.equal(cal.inRegularSession(half, 780), false, 'the 13:00 bar is after-hours');
});

test('sessions are counted across weekday holidays; the next and the previous trading day skip them', () => {
  assert.equal(cal.sessionsBetween('2026-11-25', '2026-11-26'), 0, 'Thanksgiving is not a session');
  assert.equal(cal.sessionsBetween('2026-11-25', '2026-11-27'), 1, 'Wednesday -> the Friday after = 1');
  assert.equal(cal.sessionsBetween('2026-12-23', '2026-12-28'), 2, '12-24 and 12-28 (Christmas Friday and the weekend skipped)');
  assert.equal(cal.sessionsBetween('2026-10-26', '2026-10-26'), 0);
  assert.equal(cal.nextTradingDay('2026-12-24'), '2026-12-28'); assert.equal(cal.prevTradingDay('2026-11-27'), '2026-11-25');
});

test('an unscheduled closure or 13:00 close comes from the environment, no code change', () => {
  const pc = process.env.MARKET_CLOSED_DAYS, pe = process.env.MARKET_EARLY_CLOSE_DAYS;
  try {
    process.env.MARKET_CLOSED_DAYS = '2026-11-02, junk';
    process.env.MARKET_EARLY_CLOSE_DAYS = '2026-11-03';
    assert.equal(cal.isTradingDay('2026-11-02'), false); assert.equal(cal.closeMin('2026-11-03'), 780);
    assert.equal(cal.isRegularHours(est('2026-11-02', 10, 0)), false);
  } finally {
    if (pc === undefined) delete process.env.MARKET_CLOSED_DAYS; else process.env.MARKET_CLOSED_DAYS = pc;
    if (pe === undefined) delete process.env.MARKET_EARLY_CLOSE_DAYS; else process.env.MARKET_EARLY_CLOSE_DAYS = pe;
  }
  assert.equal(cal.isTradingDay('2026-11-02'), true, 'back to the rules once the variable is gone');
});

// A full day of 5m bars as the Yahoo feed delivers it with includePrePost: 09:30-15:55 ET, whatever the close.
const feed = (day, tz, closeAt) => Array.from({ length: 78 }, (_, i) => {
  const t = tz(day, 9, 30) + i * 300000; const c = closeAt(i);
  return { timestamp: new Date(t).toISOString(), open: c, high: c + 0.05, low: c - 0.05, close: c };
});

test('session bars stop at 13:00 on an early close; a full day keeps its 78 bars', () => {
  const half = sessionBars(feed('2026-11-27', est, () => 100), '2026-11-27');
  assert.equal(half.length, 42, '09:30 .. the 12:55 bar'); assert.equal(half[half.length - 1].min, 775);
  assert.equal(sessionBars(feed('2026-11-25', est, () => 100), '2026-11-25').length, 78);
  assert.equal(sessionBars(feed('2026-09-22', edt, () => 100), '2026-09-22').length, 78, 'and in EDT');
});

test('close-IBS on a Thursday 13:00 close decides on the 12:45 and 12:50 bars, never on the after-hours bars', async () => {
  const day = '2026-12-24';   // a Thursday
  // falls from 101 to 99 into the 12:55 bar, then the after-hours prints sit at 100.5 (a high IBS by 15:55 on the old clock)
  const bars = feed(day, est, (i) => (i < 42 ? 101 - (2 * i) / 41 : 100.5));
  const scan = createCloseIbsScan({ symbols: ['AAA'], getBars: async () => ({ bars: bars.filter((b) => Date.parse(b.timestamp) <= now) }) });
  let now = est(day, 12, 50, 30); let r = await scan.scan(now);
  assert.equal(r.closeIbs.window, true, 'the 12:45 bar (closes 12:50) is a decision bar'); assert.equal(r.signals[0].direction, 'BULLISH');
  now = est(day, 12, 55, 30); r = await scan.scan(now);
  assert.equal(r.closeIbs.window, true, 'the 12:50 bar (closes 12:55) is a decision bar'); assert.equal(r.signals[0].direction, 'BULLISH');
  assert.equal(r.closeIbs.reads[0].bar, '12:55');
  now = est(day, 15, 55, 30); r = await scan.scan(now);
  assert.equal(r.closeIbs.window, false, '15:55 on an early close is not a window'); assert.notEqual(r.signals[0].direction, 'BULLISH');
  assert.equal(r.closeIbs.reads[0].bar, '13:00', 'the last session bar is the 12:55 bar, closing 13:00');
  const full = feed('2026-12-17', est, (i) => 101 - (2 * i) / 77);   // a full Thursday: unchanged, the 15:50 bar decides
  const s2 = createCloseIbsScan({ symbols: ['AAA'], getBars: async () => ({ bars: full.filter((b) => Date.parse(b.timestamp) <= est('2026-12-17', 15, 55, 30)) }) });
  r = await s2.scan(est('2026-12-17', 15, 55, 30)); assert.equal(r.closeIbs.window, true); assert.equal(r.signals[0].direction, 'BULLISH');
});

test('the overnight book buys at the 12:50 bar of a 13:00 close and not at 15:55 off after-hours prints', async () => {
  const day = '2026-11-27';
  const daily = []; for (let d = '2026-11-26', k = 0; daily.length < 260; k++) {   // rising into the day: above its mean
    d = cal.prevTradingDay(d); daily.unshift({ timestamp: `${d}T21:00:00.000Z`, close: 100 - 0.05 * daily.length });
  }
  const bars = feed(day, est, () => 100);
  let now = 0;
  const scan = createOvernightScan({ symbols: ['AAA'], getBars: async (s, tf) => (tf === '1d' ? { bars: daily } : { bars: bars.filter((b) => Date.parse(b.timestamp) <= now) }) });
  now = est(day, 12, 55, 30); let r = await scan.scan(now);
  assert.equal(r.overnight.window, 'entry'); assert.equal(r.signals[0].direction, 'BULLISH'); assert.equal(r.signals[0].decision_context.overnight_bar, '12:55');
  now = est(day, 12, 54); r = await scan.scan(now);
  assert.equal(r.overnight.window, 'sell', 'before the 12:50 bar settles the sell window reads, as before 15:55 on a full day');
  now = est(day, 15, 55, 30); r = await scan.scan(now);
  assert.equal(r.overnight.window, null, 'no entry at 15:55 on an early close'); assert.equal(r.signals[0].direction, 'NEUTRAL');
});

test('the runner, the autoscan, the order router, the market status and the leg read the calendar', () => {
  const src = (...p) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');
  const runner = src('scripts', 'two-sleeve-runner.js');
  assert.match(runner, /const cal = require\(path\.join\(APP, 'lib', 'market-calendar'\)\);/);
  assert.match(runner, /const marketHours = \(ms\) => cal\.isRegularHours\(ms\);/);
  assert.match(runner, /const extendedHours = \(ms\) => cal\.isExtendedHours\(ms\);/);
  const routes = src('routes', 'trading.js');
  assert.match(routes, /function _isUsMarketHours\(\) \{ return marketCalendar\.isRegularHours\(Date\.now\(\)\); \}/);
  assert.match(routes, /function _isUsExtendedHours\(\) \{ return marketCalendar\.isExtendedHours\(Date\.now\(\)\); \}/);
  assert.match(src('routes', 'trading', 'orders.js'), /if \(marketCalendar\.isRegularHours\(now\)\) return 'rth';/);
  assert.match(src('lib', 'market-data-yahoo.js'), /return require\('\.\/market-calendar'\)\.isRegularHours\(Date\.now\(\)\);/);
  assert.match(src('lib', 'two-sleeve', 'noise-scan.js'), /last\.min < CLOSE_MIN - closeOffset\(e\.day\)/);
  assert.equal(require('../lib/market-data-yahoo').isUsEquityMarketOpen(), cal.isRegularHours(Date.now()));
});
