'use strict';
/**
 * day-pnl-split.js — the day's equity change, split into what is banked and what is only marked
 * (2026-11-05). Reporting only: nothing here is read by a trader, and it writes nothing.
 *
 * Wednesday 2026-11-04 on the engine's account: up $394 at 09:30, +$581 at the peak, -$33 at 16:00,
 * -$329 at 20:00, all against Tuesday's close. The operator read that as a win the trader failed to
 * capture, because the page has one number for the day. The morning gain was marks on the overnight
 * holds, the evening fall was marks on the positions it carried, and the day banked -$154: M -$608,
 * C +$315, O +$139. The split shows those apart:
 *
 *     banked + marks + after hours == Day P&L       to the cent, whenever all three are known
 *
 * BANKED   Every closed trade whose fill is dated in the session, each counted WHOLE, entry to exit
 *          (the journal's `pnl`, the broker's sense of realized): what the trade made or lost. The stable
 *          server's overnight book counts too. The page's Realized P&L tile is a different figure on
 *          purpose: it counts only today's part of those trades (lib/day-pnl.js).
 * AFTER HOURS  Account equity now minus equity at the session's close (16:00 ET, 13:00 on an early
 *          close), from the close onward.
 * MARKS    The rest of the equity change. It is a remainder, which is what makes the sum exact: today's
 *          move on what is still open, less the gains closed trades already had in the previous close
 *          (they just moved from marks to banked), plus whatever the journals do not hold (fees,
 *          holdings they never recorded).
 *
 * WHICH SESSION. Not simply today's date. The day is measured from a baseline, and Alpaca's
 * last_equity does not roll at midnight: at 01:45 ET on Thursday 11-05 it was still Tuesday's close, and
 * by 07:00 it was Wednesday's with balance_asof naming that date. So at 01:45 the day on screen still held
 * all of Wednesday, and Thursday's journal rows would say "banked $0.00, marks -$789" with Wednesday's
 * -$154 inside the marks. The session is the first trading day after the baseline's date, on both brokers.
 *
 * UNKNOWN IS NOT ZERO. readTradesLedger skips a journal it cannot read, which is right for keeping
 * the page alive and is how the page read $0.00 on a +$59.62 day (2026-10-05, sleeves M and C were not
 * in TRADER_TRADES_LOG_EXTRA). Here a journal that cannot be read, a journal that holds this session's
 * exits but is not listed, and an exit row with no P&L each make that journal's figure null, the total
 * null, and marks null, since marks is what is left after banked. The Day P&L tile does not depend on
 * any of this and stays as it is.
 */
const fs = require('fs');
const path = require('path');
const cal = require('./market-calendar');

const PRE_MIN = 240;              // 04:00 ET: a new session's pre-market has started
const SESSION_ROW_MINUTES = 15;   // a session row this soon after the close reads as the close; a restart's later row does not
const HISTORY_SETTLE_MINUTES = 5; // the broker's point at the close is pinned only once this long past it
const HISTORY_RETRY_MS = 60000;   // a miss is retried at most this often: this runs on every poll of the page
const LEDGER_FILE = 'autopilot-trades.jsonl';
const JOURNAL_SUFFIX = '.' + LEDGER_FILE;
const BOOK_EVENT = 'overnight_book_gone';
const BOOK_NAME = 'O';            // the same sleeve the engine journals as O

const cents = (v) => Math.round(Number(v) * 100);
const dollars = (c) => c / 100;
const etDayOf = (ms) => cal.etOf(ms).day;
const etClock = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/** What the page calls a journal: M for M.autopilot-trades.jsonl. Never a path. */
function journalName(file) {
  const base = path.basename(String(file));
  const lower = base.toLowerCase();
  if (lower === LEDGER_FILE) return 'Trader';   // the server's own trader, whichever box this is
  const stem = lower.endsWith(JOURNAL_SUFFIX) ? base.slice(0, -JOURNAL_SUFFIX.length) : base.replace(/\.jsonl$/i, '');
  return stem.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'journal';
}

/**
 * The session a day figure describes, and where `now` sits in it. `baselineDate` is the date of the
 * close the day is measured from (Alpaca balance_asof, the IBKR path's session row). Without one, the
 * clock: today from 04:00 ET on a trading day, otherwise the last trading day.
 * Phases: pre_open, session, after_close, and stale when the next session has already opened, so the
 * baseline is too old to mean what the split would say about it.
 */
function sessionFor(baselineDate, now = Date.now()) {
  const { day, min } = cal.etOf(now);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(baselineDate || ''))
    ? cal.nextTradingDay(baselineDate)
    : (cal.isTradingDay(day) && min >= PRE_MIN ? day : cal.prevTradingDay(day));
  if (!date) return null;
  let phase;
  if (day < date) phase = 'pre_open';
  else if (day === date) phase = min < cal.OPEN_MIN ? 'pre_open' : (min < cal.closeMin(date) ? 'session' : 'after_close');
  else {
    const next = cal.nextTradingDay(date);
    phase = (day > next || (day === next && min >= cal.OPEN_MIN)) ? 'stale' : 'after_close';
  }
  return { date, phase, is_today: date === day };
}

/**
 * The lines holding a marker, without splitting the text into lines: stable's ledger is 20 MB and under 3% of
 * its lines hold one, and this runs on every poll, in the process that may be trading.
 */
function linesWith(text, markers) {
  const out = [];
  const next = markers.map((m) => text.indexOf(m));
  for (;;) {
    let at = -1;
    for (const n of next) if (n >= 0 && (at < 0 || n < at)) at = n;
    if (at < 0) return out;
    const start = text.lastIndexOf('\n', at) + 1;
    let stop = text.indexOf('\n', at);
    if (stop < 0) stop = text.length;
    out.push(text.slice(start, stop));
    markers.forEach((m, i) => { if (next[i] >= 0 && next[i] < stop) next[i] = text.indexOf(m, stop); });
  }
}

/**
 * One journal's rows that matter to `date`: its exits, the overnight book's sales, its session rows, and fills booked
 * late. The book on the stable server (lib/overnight-book.js) closes its trades on overnight_book_gone rows, never on
 * exit rows, in the same file: SPY +$790 and QQQ +$631 on 2026-11-04 would otherwise have read as marks.
 */
function scanJournal(text, date) {
  const exits = [], book = [], sessions = [], late = [];
  for (const line of linesWith(String(text || ''), ['"exit"', '"session"', `"${BOOK_EVENT}"`])) {
    let r; try { r = JSON.parse(line); } catch (_e) { continue; }   // a torn last line: the next poll reads it whole
    if (!r) continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    if (r.event === 'session') {
      if ((r.date || etDayOf(ms)) === date && Number(r.equity) > 0) sessions.push({ ts: ms, equity: Number(r.equity) });
      continue;
    }
    if (r.event === BOOK_EVENT) {
      if (r.sold === true && r.symbol && etDayOf(ms) === date) book.push(r);   // not sold: a buy that never filled, or the operator's own close
      continue;
    }
    if (r.event !== 'exit' || !r.symbol) continue;
    const day = etDayOf(ms);
    if (day === date) { exits.push(r); continue; }
    // Journaled in this session under an earlier date. fill-ledger.js stamps a stale broker time at discovery
    // since 2026-10-30, but a row like this still means the date may be wrong (SLV -$8,132 on 10-14 sat under
    // 10-12), so the page says so rather than letting it pass as marks.
    const found = Date.parse(r.discovered_at);
    if (Number.isFinite(found) && day < date && etDayOf(found) === date) late.push(r);
  }
  return { exits, book, sessions, late };
}

/** The same fill in two journals is one fill (same key as lib/day-pnl readTradesLedger). */
const exitKey = (r) => [String(r.symbol).toUpperCase(), r.order_id ? 'o:' + r.order_id : 't:' + r.ts + ':' + r.qty].join('|');

/** One line of the banked figure: what these rows closed, in cents, or unknown if one of them has no P&L. */
function tally(name, rows, seen) {
  const j = { name, pnl: null, exits: 0, status: 'ok' };
  let sum = 0, noPnl = 0, estimated = 0;
  const keys = [];
  for (const r of rows) {
    const k = exitKey(r);
    if (seen.has(k)) continue;
    keys.push(k);                  // added after the loop: inside one journal every row counts (partial fills share an order id)
    j.exits++;
    if (r.pnl == null || !Number.isFinite(Number(r.pnl))) { noPnl++; continue; }
    sum += cents(r.pnl);
    if (r.estimated === true) estimated++;
  }
  keys.forEach((k) => seen.add(k));
  if (estimated) j.estimated = estimated;
  if (noPnl) { j.status = 'no_pnl'; j.no_pnl = noPnl; } else j.pnl = dollars(sum);
  return j;
}

/**
 * Every journal the server was told about, plus any sibling it was not told about that holds exits for
 * this session. The sleeve journals sit in one directory, so that second part catches the recurring
 * failure: a sleeve added to the engine and not to TRADER_TRADES_LOG_EXTRA.
 */
async function readJournals({ primary, extras = [] } = {}, date) {
  const samePath = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  const listed = new Map();
  for (const p of [primary, ...extras]) if (p && !listed.has(samePath(p))) listed.set(samePath(p), p);

  const seen = new Set(), journals = [], sessions = [], late = [];
  for (const file of listed.values()) {
    const name = journalName(file);
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch (_e) { journals.push({ name, pnl: null, exits: 0, status: 'missing' }); continue; }
    const scan = scanJournal(text, date);
    sessions.push(...scan.sessions);
    for (const r of scan.late) late.push({ journal: name, symbol: String(r.symbol).toUpperCase(), pnl: r.pnl == null ? null : Number(r.pnl) });
    journals.push(tally(name, scan.exits, seen));
    if (scan.book.length) journals.push(tally(BOOK_NAME, scan.book, seen));
  }

  const floor = Date.parse(date + 'T00:00:00Z') - 86400000;   // a day of slack: this only skips files that cannot hold the session
  const dirs = new Set([...listed.values()].map((p) => path.dirname(p)));
  for (const dir of dirs) {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch (_e) { continue; }
    for (const n of names) {
      const lower = n.toLowerCase();
      if (lower !== LEDGER_FILE && !lower.endsWith(JOURNAL_SUFFIX)) continue;
      const file = path.join(dir, n);
      if (listed.has(samePath(file))) continue;
      try {
        if ((await fs.promises.stat(file)).mtimeMs < floor) continue;
        const scan = scanJournal(await fs.promises.readFile(file, 'utf8'), date);
        const own = scan.exits.filter((r) => !seen.has(exitKey(r)));
        if (own.length) journals.push({ name: journalName(file), pnl: null, exits: own.length, status: 'unlisted' });
      } catch (_e) { /* a sibling nobody listed and nobody can read tells us nothing */ }
    }
  }
  return { journals, sessions, late };
}

/** The account's equity at `date`'s close, from the broker's own curve: its point AT the closing minute. */
function closeFromHistory(history, date) {
  const close = cal.closeMin(date);
  if (close == null || !history || !Array.isArray(history.timestamps) || !Array.isArray(history.equity)) return null;
  for (let i = history.timestamps.length - 1; i >= 0; i--) {
    const ms = Number(history.timestamps[i]) * 1000;
    if (!Number.isFinite(ms) || !(Number(history.equity[i]) > 0)) continue;
    const at = cal.etOf(ms);
    // Exactly the closing minute, never a nearby point: on 11-04 the auction moved the account $137 from 15:55 to 16:00.
    if (at.day === date && at.min === close) return { equity: Number(history.equity[i]), source: 'broker history' };
  }
  return null;
}

/** The earliest session row in the minutes after the close. A brain writes it at/after 16:00 ET whatever the session's real close was. */
function closeFromSessionRows(rows, date) {
  const close = cal.closeMin(date);
  if (close == null) return null;
  let best = null;
  for (const r of rows || []) {
    const at = cal.etOf(r.ts);
    if (at.day !== date || at.min < close || at.min >= close + SESSION_ROW_MINUTES) continue;
    if (!best || r.ts < best.ts) best = r;
  }
  return best ? { equity: best.equity, source: `session row ${etClock(best.ts)} ET` } : null;
}

const _closeMemo = new Map();    // `${key}|${date}` -> the broker's close, which cannot change once settled
const _closeTried = new Map();   // same key -> when the broker was last asked
async function closeFromBroker(readHistory, key, date, now) {
  if (typeof readHistory !== 'function') return null;
  const k = `${key || 'account'}|${date}`;
  if (_closeMemo.has(k)) return _closeMemo.get(k);
  if (now - (_closeTried.get(k) || 0) < HISTORY_RETRY_MS) return null;
  if (_closeTried.size > 64) _closeTried.clear();
  _closeTried.set(k, now);
  let hit = null;
  try { hit = closeFromHistory(await readHistory(), date); } catch (_e) { /* a session row, or unknown */ }
  const at = cal.etOf(now);
  if (hit && (at.day !== date || at.min >= cal.closeMin(date) + HISTORY_SETTLE_MINUTES)) {
    if (_closeMemo.size > 64) _closeMemo.clear();
    _closeMemo.set(k, hit);
  }
  return hit;
}

/**
 * The split itself. Pure. All arithmetic is in cents with marks as the remainder, so what the page prints
 * adds up exactly, and the journal figures add up to the banked total.
 */
function buildSplit({ equity, prevEquity, session, journals = [], late = [], close = null } = {}) {
  const eq = Number(equity), prev = Number(prevEquity);
  const dayC = eq > 0 && prev > 0 ? cents(eq - prev) : null;
  const stale = session.phase === 'stale';
  const complete = !stale && journals.length > 0 && journals.every((j) => j.status === 'ok');   // no journal at all is not "nothing closed"
  const bankedC = complete ? journals.reduce((t, j) => t + cents(j.pnl), 0) : null;
  const applies = session.phase === 'after_close';
  const closeEq = applies && close && Number(close.equity) > 0 ? Number(close.equity) : null;
  const afterC = closeEq != null && eq > 0 ? cents(eq - closeEq) : null;
  const marksC = dayC != null && bankedC != null ? dayC - bankedC - (afterC || 0) : null;

  const notes = [];
  if (stale) notes.push('The previous close the day is measured from is older than the last session, so the split is unknown.');
  if (dayC == null && !stale) notes.push('No previous close on record, so marks are unknown.');
  for (const j of journals) {
    if (j.status === 'missing') notes.push(`The ${j.name} journal could not be read, so its closed trades are unknown.`);
    if (j.status === 'no_pnl') notes.push(`${j.name} has ${j.no_pnl} closed trade(s) with no P&L on record.`);
    if (j.status === 'unlisted') notes.push(`${j.name} has ${j.exits} closed trade(s) in this session but is not listed in TRADER_TRADES_LOG_EXTRA.`);
    if (j.estimated) notes.push(`${j.name} includes ${j.estimated} trade(s) priced from the last mark, not a fill.`);
  }
  for (const r of late) notes.push(`${r.symbol} (${r.journal}, ${r.pnl == null ? 'no P&L' : r.pnl.toFixed(2)}) was journaled this session under an earlier date and is not counted in banked.`);
  if (applies && closeEq == null) notes.push('The account value at the close is not known yet, so marks include the after-hours move.');

  return {
    session_date: session.date,
    is_today: session.is_today,
    phase: session.phase,
    day_pnl: dayC == null ? null : dollars(dayC),
    realized: { total: bankedC == null ? null : dollars(bankedC), journals },
    marks: marksC == null ? null : dollars(marksC),
    marks_include_after_hours: marksC != null && applies && afterC == null,
    after_hours: afterC == null ? null : dollars(afterC),
    after_hours_applies: applies,
    close_equity: closeEq,
    close_source: closeEq == null ? null : close.source,
    notes,
  };
}

/**
 * The split for an account, ready for the positions payload.
 *   equity, prevEquity  the day figure's own two ends; prevEquity empty = no equity-change day to split
 *   baselineDate        the date of the close prevEquity is from
 *   sources             lib/day-pnl tradesLedgerSources
 *   readHistory         optional, async -> { timestamps (s), equity[] }: the broker's curve, asked only after the close
 *   historyKey          whose curve that is
 */
async function forAccount({ equity, prevEquity, baselineDate, sources, now = Date.now(), readHistory, historyKey } = {}) {
  const session = sessionFor(baselineDate, now);
  if (!session) return null;
  const { journals, sessions, late } = await readJournals(sources, session.date);
  const close = session.phase === 'after_close'
    ? ((await closeFromBroker(readHistory, historyKey, session.date, now)) || closeFromSessionRows(sessions, session.date))
    : null;
  return buildSplit({ equity, prevEquity, session, journals, late, close });
}

module.exports = { forAccount, buildSplit, sessionFor, readJournals, scanJournal, journalName, closeFromHistory, closeFromSessionRows };
