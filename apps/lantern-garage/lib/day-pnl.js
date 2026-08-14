'use strict';

/**
 * day-pnl.js — "how much did the account make TODAY", computed once.
 *
 * Day P&L is realized + unrealized, but BOTH terms have to answer the same
 * question: how much of this moved today? A lot opened days ago and closed
 * today banked its whole lifetime gain into today's realized figure, even
 * though every dollar earned before this morning was already inside
 * yesterday's closing equity. Adding that to today's unrealized counts it
 * twice.
 *
 * Live case 2026-08-13 (paper DUR193395): the header read +$7,653.13
 * (realized $2,144.95 + unrealized $5,508.18). Four lots were carried in from
 * 8/12 and were up $5,119.60 at that close; today they gave $3,441.76 of it
 * back and were sold. Booking the net +$1,677.83 to today overstated the day
 * by $5,119.60 — the true figure was +$2,533.54. At the +0.2%/day goal
 * (~$1,944) that is the difference between "394% of target" and "130%".
 *
 * The unrealized term already had the fix (entry basis for today-opened,
 * prevClose for carried, #2026-08-08); the realized term never got it. This
 * module applies one rule to both:
 *
 *     opened today  → the full move counts
 *     carried in    → only (mark|exit − prevClose) counts
 *
 * CLASSIFICATION IS PER LOT, BY TIME — not per symbol. A symbol sold and then
 * RE-ENTERED the same day is both: GLD's 04:05 exit was the carried lot, its
 * 10:54 exit was a lot bought at 10:15. A symbol-level "was its last entry
 * today?" map answers "today" for both and mis-books the first. An exit is
 * today-opened iff a today ENTRY for that symbol precedes it in time.
 * (Matching entry PRICES instead fails in both directions here — GLD's carried
 * entry 400.28 sits within $0.60 of today's 401.05, and SOXS's 39.50 within
 * $0.60 of today's 38.92.)
 *
 * realized_today is deliberately left whole — a broker's "realized" means the
 * cash the closed trades actually banked, and that is a real quantity. Only
 * the Day P&L sum uses the attributable slice, and `pnl_carry_adjustment`
 * reports the difference so the two can be reconciled on screen.
 */

const etDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** ET wall-clock minutes since midnight, and the weekday, for `now`. */
function etClock(now) {
  const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

/** Regular session has begun (ET weekday, at/after 09:30). */
function sessionTradedToday(now) {
  const { dow, min } = etClock(now);
  return dow >= 1 && dow <= 5 && min >= 570;
}

/**
 * One pass over the ledger.
 *   entryTsBySym  sym -> [ms] of TODAY's entry rows (ascending)
 *   lastEntryDay  sym -> ET date of its most recent entry row (any day)
 *   exits         today's exit rows, normalized
 *   realizedFull  Σ pnl over today's exit rows — the broker sense of realized
 *
 * Three rules here are load-bearing, each paid for by a live mis-report:
 *
 *   SUM EVERY exit row. "One value per symbol (its LAST row)" held only while
 *   the ledger was written at order-PLACEMENT time and earlier rows were
 *   phantom re-attempts. Since #3203 a row exists only when a sell actually
 *   FILLED, so every row is a real closed trade and keeping just the last one
 *   silently drops the rest — SMH alone round-tripped 4x on 2026-08-06.
 *
 *   DON'T skip symbols that are open again. A symbol closed and RE-ENTERED the
 *   same day is open, and excluding it erased its realized P&L: on 2026-08-07
 *   that dropped QQQ (+$218.48) and XLK (−$641.92), so realized read −$230.98
 *   instead of −$654.42 and Day P&L would have printed +$80.55, not −$342.89.
 *
 *   ET trading date, not UTC. Rows are stamped UTC; from 20:00 ET each evening
 *   a UTC filter looks for fills dated TOMORROW, finds none, and drops the
 *   session's realized losses (Friday's −$654 vanished at midnight UTC).
 *
 * Superseded/estimated rows carry event:'exit_superseded' and are skipped by
 * the event filter with no special case — that is what keeps the 2026-08-13
 * phantom-exit repair (#3277) from reappearing in the totals.
 */
function scanLedger(text, now) {
  const today = etDay(now);
  const entryTsBySym = new Map();
  const lastEntryDay = new Map();
  const exits = [];
  let realizedFull = 0;
  let anyExit = false;

  for (const line of String(text || '').split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_e) { continue; }
    if (!r || !r.symbol) continue;
    const sym = String(r.symbol).toUpperCase();

    if (r.event === 'entry') {
      lastEntryDay.set(sym, etDay(r.ts));
      if (etDay(r.ts) === today) {
        if (!entryTsBySym.has(sym)) entryTsBySym.set(sym, []);
        entryTsBySym.get(sym).push(Date.parse(r.ts));
      }
      continue;
    }
    if (r.event !== 'exit') continue;
    if (etDay(r.ts) !== today) continue;
    if (r.pnl == null || !Number.isFinite(Number(r.pnl))) continue;

    realizedFull += Number(r.pnl);
    anyExit = true;
    exits.push({
      symbol: sym,
      ts: Date.parse(r.ts),
      qty: Number(r.qty),
      exit: Number(r.exit),
      pnl: Number(r.pnl),
    });
  }
  for (const arr of entryTsBySym.values()) arr.sort((a, b) => a - b);
  return { entryTsBySym, lastEntryDay, exits, realizedFull, anyExit };
}

/** A closed lot was opened today iff a today-entry for it preceded the exit. */
function exitOpenedToday(entryTsBySym, exit) {
  const ts = entryTsBySym.get(exit.symbol);
  return !!ts && ts.some((t) => t < exit.ts);
}

/**
 * Day P&L with a single basis rule applied to realized AND unrealized.
 *
 * @param {object}   o
 * @param {Array}    o.positions   [{symbol, qty, current_price, unrealized_pl}]
 * @param {string}   o.ledgerText  raw autopilot-trades.jsonl
 * @param {number}   o.now         ms epoch
 * @param {Function} o.getQuotes   async (symbols[]) -> [{ticker, price, chg_pct}]
 */
async function computeDayPnl({ positions = [], ledgerText = '', now = Date.now(), getQuotes } = {}) {
  const today = etDay(now);
  const live = sessionTradedToday(now);
  const { entryTsBySym, lastEntryDay, exits, realizedFull, anyExit } = scanLedger(ledgerText, now);

  const carriedPos = positions.filter((p) => lastEntryDay.get(String(p.symbol).toUpperCase()) !== today);
  const carriedExits = exits.filter((e) => !exitOpenedToday(entryTsBySym, e));

  // One quote call covers both terms: carried positions still open, and
  // carried lots already closed today (which are no longer in `positions`,
  // so the old call site never fetched them at all).
  const need = new Set([
    ...carriedPos.map((p) => String(p.symbol).toUpperCase()),
    ...carriedExits.map((e) => e.symbol),
  ]);
  const prevClose = new Map();
  if (need.size && typeof getQuotes === 'function') {
    try {
      for (const q of (await getQuotes([...need])) || []) {
        if (q && Number(q.price) > 0 && Number.isFinite(Number(q.chg_pct)) && (1 + Number(q.chg_pct) / 100) !== 0) {
          prevClose.set(String(q.ticker).toUpperCase(), Number(q.price) / (1 + Number(q.chg_pct) / 100));
        }
      }
    } catch (_e) { /* degrade to the whole-lot basis below, and say so */ }
  }

  // ── realized, attributed ────────────────────────────────────────────────
  let realizedAttr = 0;
  let realizedDegraded = false;
  for (const e of exits) {
    if (exitOpenedToday(entryTsBySym, e)) { realizedAttr += e.pnl; continue; }
    const pc = prevClose.get(e.symbol);
    if (pc > 0 && Number.isFinite(e.exit) && Number.isFinite(e.qty) && e.qty) {
      realizedAttr += (e.exit - pc) * e.qty;      // carried: only today's leg
    } else {
      realizedAttr += e.pnl;                      // no prevClose → whole lot, flagged
      realizedDegraded = true;
    }
  }

  // ── unrealized, attributed ──────────────────────────────────────────────
  // Two failure modes this shape exists to avoid:
  //   Summing every position's move since YESTERDAY'S close credits a position
  //   opened at 15:36 with the whole morning rally it was never in. On
  //   2026-08-07 that printed +$1,383.96 while the broker read −$337.60.
  //   Adding the FULL since-entry unrealized instead re-counts every prior
  //   day's move on a multi-day hold, every new day.
  // Hence: today-opened → since entry; carried → since prevClose.
  let unreal = 0;
  let unrealDegraded = false;
  for (const p of positions) {
    const sym = String(p.symbol).toUpperCase();
    const qty = Number(p.qty) || 0;
    const cur = Number(p.current_price) || 0;
    const isCarried = lastEntryDay.get(sym) !== today;
    const pc = prevClose.get(sym);
    if (isCarried && !live) continue;                       // no session → carried moved $0
    if (isCarried && pc > 0 && cur > 0 && qty) {
      unreal += (cur - pc) * qty;                           // carried: today's move
    } else {
      unreal += Number(p.unrealized_pl) || 0;               // opened today: since entry
      if (isCarried) unrealDegraded = true;
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  const pnlToday = round(realizedAttr + unreal);

  let basis = 'realized(ET ledger fills) + unrealized change today'
    + ' (entry basis for today-opened, prevClose for carried — both terms)';
  if (!live) basis += ' (no session today — carried positions contribute $0)';
  if (realizedDegraded || unrealDegraded) basis += ' (prevClose unavailable for some carried lots — shown since entry)';
  basis += '; excludes commissions';

  return {
    realized_today: anyExit ? round(realizedFull) : 0,   // broker sense: cash banked
    realized_attributable: round(realizedAttr),          // the slice that moved today
    pnl_carry_adjustment: round(realizedFull - realizedAttr),
    unrealized_today: round(unreal),
    pnl_today: pnlToday,
    pnl_basis: basis,
    degraded: realizedDegraded || unrealDegraded,
  };
}

module.exports = { computeDayPnl, scanLedger, exitOpenedToday, sessionTradedToday, etDay };
