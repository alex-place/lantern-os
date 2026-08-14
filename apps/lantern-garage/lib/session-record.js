'use strict';

/**
 * session-record.js — one row per trading day, so a session can be QUERIED
 * instead of re-derived.
 *
 * The trade ledger holds every entry, exit and skip, but nothing held the
 * SESSION: no closing equity, no day P&L, no tier split. The cost of that is
 * concrete. Verifying 2026-08-13's day P&L needed yesterday's closing equity;
 * because nothing had ever stored it, the only route was to reconstruct it from
 * bar-cache closes and a full per-lot decomposition. That decomposition is what
 * turned up #3283 — the double-count had been shipping unseen because the
 * authoritative check, equity(today) − equity(yesterday), was impossible after
 * the fact.
 *
 * ONE MEMORY, NOT TWO. These rows append to the existing autopilot-trades.jsonl
 * as `event:'session'` rather than opening a second store (CLAUDE.md: one
 * append-only JSONL). Every existing reader filters on `event`, so an unknown
 * type is skipped — day-pnl.js counts only 'exit', the scorecard only 'exit',
 * the backtest only 'entry'/'exit'. Nothing needs to change to tolerate it.
 *
 * WRITTEN ONCE PER ET DAY, at/after the close. Idempotence is checked against
 * the ledger itself, not against in-memory state, so a mid-session restart
 * cannot produce a second row for the same date.
 */

const { etDay } = require('./day-pnl');

/** ET wall-clock minutes since midnight for `now`. */
function etMinutes(now) {
  const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

const CLOSE_MIN = 16 * 60;   // 16:00 ET

/**
 * Parse today's rows out of the ledger, plus whether a session row already
 * exists for the date. One pass; the ledger is small (a few thousand rows).
 */
function scanDay(ledgerText, now) {
  const date = etDay(now);
  const entries = [];
  const exits = [];
  const skips = new Map();
  const slotRows = [];
  let alreadyWritten = false;

  for (const line of String(ledgerText || '').split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_e) { continue; }
    if (!r || !r.ts) continue;
    if (etDay(r.ts) !== date) continue;

    if (r.event === 'session') { alreadyWritten = true; continue; }
    if (r.event === 'entry') { entries.push(r); continue; }
    if (r.event === 'exit') { exits.push(r); continue; }
    if (r.event === 'slot_util') { slotRows.push(r); continue; }
    if (r.event === 'skip' && r.reason) {
      // collapse numbers so "p_win 0.51 < 0.55" and "p_win 0.62 < 0.55" are one
      // reason, otherwise the histogram is thousands of unique strings
      const k = String(r.reason).replace(/[0-9]+(\.[0-9]+)?/g, '#').slice(0, 60);
      skips.set(k, (skips.get(k) || 0) + 1);
    }
  }
  return { date, entries, exits, skips, slotRows, alreadyWritten };
}

/**
 * Should a session row be written right now?
 * ET weekday, at/after the close, the day actually did something, and no row
 * for this date exists yet.
 */
function shouldWriteSession(ledgerText, now) {
  const { dow, min } = etMinutes(now);
  if (dow < 1 || dow > 5) return false;
  if (min < CLOSE_MIN) return false;
  const d = scanDay(ledgerText, now);
  if (d.alreadyWritten) return false;
  // A holiday or a fully-idle day has nothing worth a row.
  return (d.entries.length + d.exits.length + d.slotRows.length) > 0;
}

/**
 * Build the row. Pure — takes everything it needs, touches no clock or disk.
 *
 * `dayPnl` is the object from computeDayPnl(), so the stored figures are the
 * SAME ones the panel showed; a later post-mortem never has to guess which
 * basis was in effect.
 */
function buildSessionRecord({ ledgerText = '', now = Date.now(), account = {}, positions = [], dayPnl = {} } = {}) {
  const { date, entries, exits, skips, slotRows } = scanDay(ledgerText, now);

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

  // tier split — where the day's size actually went
  const tiers = {};
  for (const e of entries) {
    const t = e.tier || '?';
    if (!tiers[t]) tiers[t] = { n: 0, notional: 0 };
    tiers[t].n += 1;
    tiers[t].notional += Number(e.notional) || 0;
  }
  for (const t of Object.values(tiers)) t.notional = Math.round(t.notional);

  // exits by reason — which mechanism actually did the work
  const byReason = {};
  for (const x of exits) {
    const k = String(x.reason || 'unknown').split('(')[0].trim().slice(0, 40);
    if (!byReason[k]) byReason[k] = { n: 0, pnl: 0 };
    byReason[k].n += 1;
    byReason[k].pnl += Number(x.pnl) || 0;
  }
  for (const v of Object.values(byReason)) v.pnl = Math.round(v.pnl * 100) / 100;

  const slotsUsed = slotRows.map((s) => Number(s.slots_used) || 0);
  // Match the NORMALIZED reason, not the raw string. `closed_externally
  // (position left the book — protective stop, manual close, or another
  // engine)` contains the word "stop" while being precisely the case where we
  // do NOT know a stop fired — that ambiguity is #3281. Counting it here would
  // inflate stops_fired with maybes.
  const isStop = (x) => /stop/i.test(String(x.reason || '').split('(')[0]);
  const stops = exits.filter(isStop);

  return {
    ts: new Date(now).toISOString(),
    event: 'session',
    date,
    // ── the account, so equity(today) − equity(yesterday) is answerable later
    equity: round(account.equity),
    cash: round(account.cash),
    // ── P&L exactly as the panel reported it
    day_pnl: num(dayPnl.pnl_today),
    realized_today: num(dayPnl.realized_today),
    realized_booked: num(dayPnl.realized_booked),
    unrealized_today: num(dayPnl.unrealized_today),
    carry_adjustment: num(dayPnl.pnl_carry_adjustment),
    pnl_basis: dayPnl.pnl_basis || null,
    // ── activity
    entries: entries.length,
    exits: exits.length,
    symbols_entered: [...new Set(entries.map((e) => e.symbol))].sort(),
    tiers,
    exits_by_reason: byReason,
    stops_fired: stops.length,
    stops_pnl: round(stops.reduce((t, x) => t + (Number(x.pnl) || 0), 0)),
    max_slots_used: slotsUsed.length ? Math.max(...slotsUsed) : null,
    slot_cap: slotRows.length ? (Number(slotRows[slotRows.length - 1].cap) || null) : null,
    // ── the book carried into tonight: what tomorrow's gap acts on
    carried_out: positions
      .filter((p) => Math.abs(Number(p.qty) || 0) > 0)
      .map((p) => ({
        symbol: String(p.symbol).toUpperCase(),
        qty: Number(p.qty),
        mark: num(p.current_price),
        unrealized: round(p.unrealized_pl),
        day_pnl: round(p.day_pnl),
      }))
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
    open_risk: round(positions.reduce((t, p) => t + (Number(p.unrealized_pl) || 0), 0)),
    skips: Object.fromEntries([...skips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
  };
}

module.exports = { buildSessionRecord, shouldWriteSession, scanDay, CLOSE_MIN };
