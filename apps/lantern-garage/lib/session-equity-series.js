'use strict';
/**
 * session-equity-series.js — the account's equity at each session close, from the brains' nightly
 * `session` rows: the journal's ACCOUNT measure for a box whose broker returns no history.
 *
 * The journal's calendar has two measures (#3517): Booked (what closed that day, from the exit rows)
 * and Account (the account's change from the previous close, open positions included). The Account
 * measure and its chips come from /api/trading/portfolio/history — the broker's own equity series —
 * and on the stable box (IBKR, 2026-10-09) that call answers nothing, so the calendar was pinned to
 * Booked while the header still showed the live account figure: +$3,145 "today so far" beside a
 * $1,708 cell, two measures with no toggle to reconcile them (the three Thursday carries, booked
 * whole on Friday, had sat on -$1,385 at Thursday's close).
 *
 * Every brain writes one `session` row per trading day at the close: { date, equity, day_pnl, … },
 * equity being the account's — the same number from every sleeve of a multi-sleeve box. That is an
 * equity series at the session close, one point per date: enough for the same { timestamps, equity }
 * shape the adapters return, so the page's parser, chips and chart work unchanged. The series starts
 * where the session rows start (not at the account's opening balance), and the response says so
 * (`source: 'session-rows'`) so the page can label it honestly.
 *
 *   fromRows(rows)                   pure: rows (parsed or JSONL text) -> series | { ok:false, reason }
 *   fromLedgers({ primary, extras })  reads every ledger (an unreadable one is skipped), merges the
 *                                    session rows across them (the latest row per date wins)
 */
const fs = require('fs');

const MIN_DAYS = 3;   // the page's own floor: fewer points than this read as "no history"

function parseRows(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  for (const line of String(input || '').split('\n')) {
    if (line.indexOf('"session"') < 0) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* a torn line is not a session */ }
  }
  return out;
}

/** One point per date: the latest session row's equity. */
function fromRows(input) {
  const byDate = new Map();
  for (const r of parseRows(input)) {
    if (!r || r.event !== 'session') continue;
    const date = String(r.date || '');
    const equity = Number(r.equity);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(equity > 0) || !Number.isFinite(equity)) continue;
    const ts = Date.parse(r.ts || '') || Date.parse(date + 'T20:00:00Z');   // a session row is written at the close (~16:00 ET)
    const cur = byDate.get(date);
    if (!cur || ts >= cur.ts) byDate.set(date, { ts, equity });
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < MIN_DAYS) return { ok: false, reason: `only ${dates.length} session row(s); the account view needs ${MIN_DAYS} closes` };
  // Each point sits at that date's 16:00 ET close (20:00Z in summer, 21:00Z in winter: both the same
  // UTC date), not at the row's own ts: a row written late — a restart after 20:00 ET — must not
  // land on the next day when the page maps the timestamp back to an exchange day.
  const timestamps = dates.map((d) => Math.round(Date.parse(d + 'T20:00:00Z') / 1000));
  const equity = dates.map((d) => byDate.get(d).equity);
  return { ok: true, source: 'session-rows', range: 'ALL', base_value: equity[0], timestamps, equity, dates, days: dates.length };
}

/** The box's ledgers: the primary and the TRADER_TRADES_LOG_EXTRA set (lib/day-pnl tradesLedgerSources). */
function fromLedgers({ primary, extras = [] } = {}) {
  const rows = [];
  let read = 0;
  for (const p of [primary, ...extras].filter(Boolean)) {
    try { rows.push(...parseRows(fs.readFileSync(p, 'utf8'))); read++; } catch (_e) { /* reporting degrades, it never breaks the page */ }
  }
  if (!read) return { ok: false, reason: 'no ledger could be read' };
  return fromRows(rows);
}

module.exports = { fromRows, fromLedgers, MIN_DAYS };
