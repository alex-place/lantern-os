'use strict';
/**
 * market-calendar.js — the NYSE session calendar, by rule (2026-10-26).
 *
 * Every trading clock in the app assumed a weekday 09:30-16:00 ET session: the two-sleeve runner's market hours, the
 * server's autoscan window, the scans' 15:45-15:55 decision bars and the brain's de-carry / eod_flat / max_hold
 * windows. Two kinds of day break that assumption:
 *   - FULL CLOSURES (Thanksgiving, Good Friday, ...): the clock said "open" and every rule ran into a closed market;
 *   - 13:00 EARLY CLOSES (the day after Thanksgiving; July 3 and December 24 on Monday-Thursday): the scans read Yahoo
 *     bars with pre/post-market prints, so 13:00-15:55 after-hours prints looked like an ordinary afternoon, and the
 *     15:50-15:55 rules (the leg's de-carry, Friday's eod_flat, C's max_hold, C's and O's closing decisions) fired
 *     after the close, where a market DAY order cannot fill until the next session. A 3x position open at 13:00 on
 *     2026-12-24 would have been carried Thursday -> Monday.
 * This module answers, for an ET date: is it a session, and when does it close. The rules (NYSE Rule 7.2):
 *   closed  New Year's Day (Sunday -> Monday; Saturday -> no closure, the Friday is a year end), Martin Luther King Jr.
 *           Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor
 *           Day, Thanksgiving, Christmas (a Saturday holiday closes the Friday before, a Sunday one the Monday after),
 *           and the one-off closures in SPECIAL_CLOSED;
 *   13:00   July 3 and December 24 when they fall Monday-Thursday, and the Friday after Thanksgiving.
 * Checked against the replay caches (test/market-calendar.test.js): the 102 weekdays with no SPY session from
 * 2016-01-04 to 2026-10-23 are exactly this module's closures, and the 21 sessions whose after-13:00 bars thin out to
 * after-hours prints are exactly its 13:00 closes. An unscheduled closure (a day of mourning, a weather closure) goes
 * in MARKET_CLOSED_DAYS=YYYY-MM-DD,... and an unscheduled 13:00 close in MARKET_EARLY_CLOSE_DAYS: no code change.
 *
 * Minutes are ET minutes after midnight, as everywhere else in the trading code (570 = 09:30, 960 = 16:00).
 * closeOffset(day) is how much earlier than 16:00 the session ends (0 on a full day, 180 on a 13:00 close): a rule
 * written against the 16:00 close (the 15:55 de-carry, the 15:50 decision bar) moves by it.
 */
const OPEN_MIN = 570;          // 09:30 ET
const CLOSE_MIN = 960;         // 16:00 ET
const EARLY_CLOSE_MIN = 780;   // 13:00 ET
const PRE_MIN = 240;           // 04:00 ET: the pre-market opens
const POST_MINUTES = 240;      // the after-hours session runs 4 hours past the close (16:00-20:00, 13:00-17:00)
const SPECIAL_CLOSED = [
  '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14',   // September 11
  '2004-06-11', '2007-01-02',                                // days of mourning (Reagan, Ford)
  '2012-10-29', '2012-10-30',                                // Hurricane Sandy
  '2018-12-05', '2025-01-09',                                // days of mourning (G. H. W. Bush, Carter)
];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();          // 0 Sunday .. 6 Saturday
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** Day of month of the n-th `wd` weekday of month m (n = -1: the last one). */
function nth(y, m, wd, n) {
  if (n > 0) return 1 + ((wd - weekday(y, m, 1) + 7) % 7) + 7 * (n - 1);
  const last = daysIn(y, m); return last - ((weekday(y, m, last) - wd + 7) % 7);
}
/** Easter Sunday [month, day] (the anonymous Gregorian computus). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * mm + 114) / 31), ((h + l - 7 * mm + 114) % 31) + 1];
}
const envDays = (name) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));

const _years = new Map();
/** { closed: Set, early: Set } of year y, memoized per year and override strings. */
function yearTable(y) {
  const key = `${y}|${process.env.MARKET_CLOSED_DAYS || ''}|${process.env.MARKET_EARLY_CLOSE_DAYS || ''}`;
  if (_years.has(key)) return _years.get(key);
  const closed = new Set(), early = new Set();
  const on = (set, m, d) => set.add(ymd(y, m, d));
  const observed = (m, d) => { const w = weekday(y, m, d); on(closed, m, w === 6 ? d - 1 : w === 0 ? d + 1 : d); };
  const ny = weekday(y, 1, 1); if (ny === 0) on(closed, 1, 2); else if (ny !== 6) on(closed, 1, 1);
  if (y >= 1998) on(closed, 1, nth(y, 1, 1, 3));                                   // Martin Luther King Jr. Day
  on(closed, 2, nth(y, 2, 1, 3));                                                    // Washington's Birthday
  const [em, ed] = easter(y); closed.add(addDays(ymd(y, em, ed), -2));               // Good Friday
  on(closed, 5, nth(y, 5, 1, -1));                                                   // Memorial Day
  if (y >= 2022) observed(6, 19);                                                    // Juneteenth
  observed(7, 4);                                                                    // Independence Day
  on(closed, 9, nth(y, 9, 1, 1));                                                    // Labor Day
  const thanks = nth(y, 11, 4, 4); on(closed, 11, thanks);                           // Thanksgiving
  observed(12, 25);                                                                  // Christmas
  const j3 = weekday(y, 7, 3); if (j3 >= 1 && j3 <= 4) on(early, 7, 3);
  on(early, 11, thanks + 1);
  const x24 = weekday(y, 12, 24); if (x24 >= 1 && x24 <= 4) on(early, 12, 24);
  const yy = String(y);
  for (const d of SPECIAL_CLOSED.concat(envDays('MARKET_CLOSED_DAYS'))) if (d.startsWith(yy)) closed.add(d);
  for (const d of envDays('MARKET_EARLY_CLOSE_DAYS')) if (d.startsWith(yy)) early.add(d);
  for (const d of closed) early.delete(d);
  const t = { closed, early }; _years.set(key, t); return t;
}

/** Is `day` (YYYY-MM-DD, ET) a regular trading session? */
function isTradingDay(day) {
  const y = Number(String(day).slice(0, 4)), m = Number(String(day).slice(5, 7)), d = Number(String(day).slice(8, 10));
  if (!(y > 1900) || !(m >= 1) || !(d >= 1)) return false;
  const w = weekday(y, m, d); if (w === 0 || w === 6) return false;
  return !yearTable(y).closed.has(day);
}
/** The session's closing minute (960, or 780 on a 13:00 close), or null when the market is closed all day. */
function closeMin(day) {
  if (!isTradingDay(day)) return null;
  return yearTable(Number(day.slice(0, 4))).early.has(day) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}
/** Minutes the session ends before 16:00 (0 on a full day and on a closed day, 180 on a 13:00 close). */
function closeOffset(day) { const c = closeMin(day); return c == null ? 0 : CLOSE_MIN - c; }
/** Is ET minute `min` of `day` inside the regular session (09:30 to its close)? */
function inRegularSession(day, min) { const c = closeMin(day); return c != null && min >= OPEN_MIN && min < c; }

const _FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
/** { day: 'YYYY-MM-DD', min } of an instant, in ET. */
function etOf(ms) {
  const p = _FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
/** Is the regular session open at `ms`? */
function isRegularHours(ms = Date.now()) { const e = etOf(ms); return inRegularSession(e.day, e.min); }
/** Is `ms` in the pre-market (04:00-09:30) or the after-hours session (the close + 4 h) of a trading day? */
function isExtendedHours(ms = Date.now()) {
  const e = etOf(ms); const c = closeMin(e.day); if (c == null) return false;
  return (e.min >= PRE_MIN && e.min < OPEN_MIN) || (e.min >= c && e.min < c + POST_MINUTES);
}
/** The first trading day after / before `day`. */
function nextTradingDay(day) { let d = day; for (let i = 0; i < 30; i++) { d = addDays(d, 1); if (isTradingDay(d)) return d; } return null; }
function prevTradingDay(day) { let d = day; for (let i = 0; i < 30; i++) { d = addDays(d, -1); if (isTradingDay(d)) return d; } return null; }
/** Trading sessions after `fromDay` up to and including `toDay` (fromDay -> its next session = 1). */
function sessionsBetween(fromDay, toDay) {
  let n = 0, d = fromDay;
  for (let i = 0; i < 800 && d < toDay; i++) { d = addDays(d, 1); if (isTradingDay(d)) n++; }
  return n;
}

module.exports = {
  OPEN_MIN, CLOSE_MIN, EARLY_CLOSE_MIN, SPECIAL_CLOSED,
  isTradingDay, closeMin, closeOffset, inRegularSession, isRegularHours, isExtendedHours,
  nextTradingDay, prevTradingDay, sessionsBetween, etOf, easter,
};
