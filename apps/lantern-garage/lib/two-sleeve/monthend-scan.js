'use strict';
/**
 * lib/two-sleeve/monthend-scan.js — THE MONTH-END BOND BOOK (sleeve T) as an engine sleeve's SCAN (2026-11-07, DRAFT: not armed).
 *
 * Treasuries rally into the month's end: the 10-year yield falls by about 2-3 bp from the close of the month's third-to-last
 * session (M-3) to the close of its last (M), the strongest of the month's 24 positions at every maturity, out of sample from
 * 1990 (ledger tier0-month-end-yields-oos-1962-2003; Hartley and Schwarz 2019 for the literature). TLT held over that window,
 * net of 7.8 bp: +0.33 % a hold 2004-2015, +0.22 % 2016-2026, 21 of 23 years positive, weekly correlation with the armed design
 * about 0.05. Through the engine at 10 % of the book (tier1-tlt-month-end-book-13-windows, tier2-tlt-month-end-book-30-quarters):
 * decade 0.2114 -> 0.2175 %/wk, Sharpe 2.37 -> 2.43, the worst week unchanged, no -2 % week, the other sleeves trade-for-trade
 * unchanged; the lift is the calendar position, not generic bond exposure (desc-t-overlay-placebo-offsets-2016-2026). It is
 * small: about +0.3 %/yr at 10 %.
 *
 * This module only READS bars and the exchange calendar (lib/market-calendar.js) and says what the sleeve wants, in the signal
 * shape the brains trade:
 *   - on the ENTRY DAY (the session with exactly `holdSessions` = 3 sessions left in its calendar month), in the ENTRY WINDOW
 *     — the session's latest COMPLETED 5m bar being the 15:50 bar (closes 15:55; read from 15:55:20 until 16:00 ET) — every
 *     name is BULLISH / ENTER;
 *   - on the EXIT DAY (the month's last session), in the same window, every name is BEARISH / ENTER (the brain sells a held
 *     one; a name it does not hold is "bearish, no long to exit");
 *   - otherwise NEUTRAL / SKIP: a held name is held. No reading (no completed bar) is NEUTRAL.
 * On a 13:00 early close the window moves with the close (the 12:50 bar, nothing at or after 13:00), as in the overnight scan.
 * The entry is always on M-3 and the sale always on M: a missed entry window is a missed month (as in the replay), and a
 * missed sale is left to the brain's own backstop, TRADER_MAX_HOLD_SESSIONS=4 (one session past M, at its 15:50).
 * The sleeve's env must hold the name over nights and weekends: TRADER_EOD_FLAT=off, TRADER_EOD_DECARRY=0,
 * TRADER_NO_FRIDAY_ENTRIES=0 (M-3 can be a Friday), the entry gates off (IBS max 1, no confirmation, no cadence, no hour
 * block), the exit rules off (IBS exit 0, no locks, no trail, no take-profit, no momentum exit) and
 * TRADER_MAX_HOLD_SESSIONS=4 (see scripts/two-sleeve.config.monthend.example.json). TLT's monthly dividend goes ex on the
 * month's first session, after the sale.
 *
 * SHADOW (TRADER_MONTHEND_SHADOW=1): the same reads, NEUTRAL signals, and journal rows instead of orders: one
 * `monthend_shadow` row per name at the first entry-window read on the entry day (the 15:55 price) and one
 * `monthend_shadow_exit` row at the first exit-window read on the exit day (the price and the return against the entry day's
 * own entry bar, read from the same 5m bars, so a runner restart in between loses nothing).
 *
 * THE MISSED WINDOW (armed or shadow): an entry or exit day whose window was read without its bar ever settling (a late 5m
 * feed, as on 2026-10-30) journals one `monthend_window_missed` row after the close, with the reads and each name's newest
 * settled bar. A scan that never read the window (a worker started after 16:00) cannot tell and says nothing.
 */
const { sessionBars, etOf } = require('../trend-shadow');
const { closeOffset, isTradingDay, nextTradingDay } = require('../market-calendar');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;                 // a bar is read 20 s after it closes (feed lag), as the other scans read it
const ENTRY_BAR = 950;                   // the 15:50 bar (closes 15:55); the 12:50 bar on a 13:00 close
const CLOSE_MIN = 960;                   // no decision at or after 16:00 ET (13:00 on an early close)
const HOLD_SESSIONS = 3;                 // buy with this many sessions left in the month (M-3), sell on the last (M)

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Trading sessions after `day` that fall in the same calendar month (0 on the month's last session). */
function sessionsLeftInMonth(day) {
  let n = 0, d = day;
  for (let i = 0; i < 31; i++) { d = nextTradingDay(d); if (!d || d.slice(0, 7) !== day.slice(0, 7)) break; n++; }
  return n;
}
/** The role of `day` (YYYY-MM-DD, ET): 'entry' (M-3), 'exit' (M) or null (any other day, or not a session). */
function monthEndRole(day, holdSessions = HOLD_SESSIONS) {
  if (!isTradingDay(day)) return null;
  const left = sessionsLeftInMonth(day);
  return left === holdSessions ? 'entry' : left === 0 ? 'exit' : null;
}
/** The month's hold { entry, exit } for the month of `day`: its M-3 and M sessions (entry null in a month that short). */
function monthHold(day, holdSessions = HOLD_SESSIONS) {
  const ym = String(day).slice(0, 7); let d = `${ym}-01`; let entry = null, exit = null;
  if (isTradingDay(d)) { if (monthEndRole(d, holdSessions) === 'entry') entry = d; if (monthEndRole(d, holdSessions) === 'exit') exit = d; }
  for (let i = 0; i < 31; i++) {
    d = nextTradingDay(d); if (!d || d.slice(0, 7) !== ym) break;
    const r = monthEndRole(d, holdSessions); if (r === 'entry') entry = d; else if (r === 'exit') exit = d;
  }
  return { entry, exit };
}

function createMonthEndScan({ symbols = ['TLT'], getBars, holdSessions = HOLD_SESSIONS, entryBar = ENTRY_BAR, shadow = false, log = null } = {}) {
  const S = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!S.length) throw new Error('month-end scan: at least one symbol (the bond fund) required');
  if (typeof getBars !== 'function') throw new Error('month-end scan: getBars(sym, tf) required');
  if (!(Number.isInteger(holdSessions) && holdSessions >= 1 && holdSessions <= 10)) throw new Error(`month-end scan: holdSessions ${holdSessions} must be 1..10`);
  const logged = {};           // sym -> { entry: day, exit: day } (shadow rows, once a day)
  const windowSeen = {};       // day -> { reads, open: { sym: true }, bars, last, logged } (the missed-window row)

  async function rawOf(sym) { try { const r = await getBars(sym, '5m'); return (r && r.bars) || null; } catch (_e) { return null; } }

  /** One scan: { signals, monthend: { at, day, role, sessions_left, window, shadow, reads } }. Never throws. */
  async function scan(now = Date.now()) {
    const e = etOf(now);
    const role = monthEndRole(e.day, holdSessions);
    const off = closeOffset(e.day);
    const signals = []; const reads = []; let window = null;
    for (const sym of S) {
      const raw = await rawOf(sym);
      const done = raw ? sessionBars(raw, e.day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now) : [];
      const last = done.length ? done[done.length - 1] : null;
      const inWindow = !!(role && last && last.min === entryBar - off && e.min < CLOSE_MIN - off);
      let direction = 'NEUTRAL', dec = 'SKIP', why;
      if (!raw || !raw.length) why = 'no bars'; else if (!last) why = 'no completed bar today';
      else if (!role) why = 'not an entry or exit day';
      else if (!inWindow) why = `${role} day, outside the ${hhmm(entryBar - off + 5)} window`;
      if (inWindow) {
        window = role;
        if (role === 'entry') { direction = 'BULLISH'; dec = 'ENTER'; } else { direction = 'BEARISH'; dec = 'ENTER'; }
        if (shadow && log) {
          const L = logged[sym] = logged[sym] || {};
          if (role === 'entry' && L.entry !== e.day) {
            L.entry = e.day;
            log({ event: 'monthend_shadow', symbol: sym, day: e.day, bar: hhmm(last.min + 5), px: round(last.c), would: 'buy', exit_day: monthHold(e.day, holdSessions).exit, shadow: true });
          } else if (role === 'exit' && L.exit !== e.day) {
            L.exit = e.day;
            const entryDay = monthHold(e.day, holdSessions).entry;
            const ent = entryDay ? sessionBars(raw, entryDay).find((b) => b.min === entryBar - closeOffset(entryDay)) : null;
            log({ event: 'monthend_shadow_exit', symbol: sym, day: e.day, bar: hhmm(last.min + 5), px: round(last.c), entry_day: entryDay,
              entry_px: ent ? round(ent.c) : null, ret_pct: ent ? round(100 * (last.c / ent.c - 1)) : null, would: 'sell', shadow: true });
          }
        }
      }
      if (shadow) { direction = 'NEUTRAL'; dec = 'SKIP'; }
      signals.push({
        symbol: sym, direction, entry_price: last ? last.c : null, price: last ? last.c : null, monthend: true,
        decision_context: { ibs: 0.1, spy_tape: 0, monthend_role: role, monthend_bar: last ? hhmm(last.min + 5) : null, monthend_window: inWindow ? role : null },
        convergence: { decision: dec, p_win: 0.6 },
      });
      reads.push({ symbol: sym, bar: last ? hhmm(last.min + 5) : null, why });
    }
    missedWindow(e, role, now, signals, reads);
    return { signals, monthend: { at: new Date(now).toISOString(), day: e.day, role, sessions_left: isTradingDay(e.day) ? sessionsLeftInMonth(e.day) : null, window, shadow: !!shadow, holdSessions, reads } };
  }

  /** The missed-window row (see the header): count the window's reads on an entry or exit day, journal once after the close if it never opened. */
  function missedWindow(e, role, now, signals, reads) {
    if (!role) return;
    const off = closeOffset(e.day);
    for (const d of Object.keys(windowSeen)) if (d !== e.day) delete windowSeen[d];
    const W = windowSeen[e.day] = windowSeen[e.day] || { reads: 0, open: {}, bars: null, last: null, logged: false };
    if (e.min >= entryBar + 5 - off && e.min < CLOSE_MIN - off) {
      W.reads += 1; W.last = now; W.bars = Object.fromEntries(reads.map((x) => [x.symbol, x.bar]));
      for (const x of signals) if (x.decision_context.monthend_window) W.open[x.symbol] = true;
    }
    if (e.min < CLOSE_MIN - off || W.logged || !W.reads || !log) return;
    W.logged = true;
    const missed = S.filter((s) => !W.open[s]);
    if (!missed.length) return;
    log({ event: 'monthend_window_missed', day: e.day, role, symbols: missed, reads: W.reads, last_read: new Date(W.last).toISOString(),
      newest_bar_end: W.bars, shadow: !!shadow,
      why: `the ${hhmm(entryBar - off)} bar never settled on any of the ${role} window's ${W.reads} read(s): a late 5m feed, ${role === 'entry' ? 'nothing bought this month' : 'the sale is left to the max-hold backstop'}` });
  }

  return { symbols: S, scan, holdSessions, shadow: !!shadow };
}

module.exports = { createMonthEndScan, monthEndRole, monthHold, sessionsLeftInMonth, ENTRY_BAR, HOLD_SESSIONS, SETTLE_MS };
