'use strict';
/**
 * lib/reserve-fund.js — the stable server's cash reserve (2026-10-28).
 *
 * The engine's cash reserve (lib/two-sleeve/reserve.js, #3788) for the server's day-trader. TRADER_MAX_GROSS_PCT
 * keeps the rest of equity in cash (stable: gross 60, so at least 40 % cash since 10-28), and a paper account pays
 * no interest on cash. The reserve parks a fixed share of equity in ONE cash-like fund (BOXX: its T-bill yield
 * accrues in its price, no regular distributions) and leaves it alone. Same decision (planReserve: target, band,
 * cash floor, whole shares, pct 0 unwinds) and the same cadence (one decision per ET session, at the first scan
 * inside a quiet window; a restart inside the window does not decide twice).
 *
 *   - Partition: the fund is not the day-trader's position. auto-trader adds symbols() to every pass's exclude set
 *     (no exit, stop, sell or entry touches it) and leaves it out of every count of open risk: the concurrency cap,
 *     the correlated-risk buckets, the gross cap, the slot_util row and the re-protect guard. It IS the cash the
 *     gross cap keeps, parked.
 *   - Size: with the gross cap at 60 the trader holds at most 60 % of equity, so a fund at 35 % with the 5 % cash
 *     floor leaves 5 % or more in cash at the cap. The cap is measured at entry and marks move; when cash is under
 *     the floor at the next decision, the reserve sells enough of the fund to restore it. Cash is read two ways
 *     (IBKR's cash field, and equity minus the marked positions) and the plan takes the cautious one of each
 *     (see `view` below): the field reads low after a day's buys, the difference reads high on a feed dropout.
 *   - Orders go out flagged reserve: true, which the IBKR order guard (lib/trading-guard.js) caps at the reserve's
 *     ceiling (a T-bill fund, at most 90 % of equity) instead of the trader's per-position cap.
 *   - Only the operator's own book (local-owner), and only from an instance armed for entries
 *     (TRADER_AUTO_EXECUTE=1): an exits-only or disarmed server never buys.
 *
 * Config (env; TRADER_RESERVE_FUND_PCT absent, blank or not a number in 0..90 = no reserve):
 *   TRADER_RESERVE_FUND_PCT=35  TRADER_RESERVE_FUND_SYMBOL=BOXX  TRADER_RESERVE_FUND_BAND_PCT=10
 *   TRADER_RESERVE_FUND_MIN_CASH_PCT=5  TRADER_RESERVE_FUND_WINDOW=12:00-12:30
 * Unwind: TRADER_RESERVE_FUND_PCT=0 for one session sells the whole holding; then remove the knobs. Removed while
 * still held, the fund becomes an ordinary long of the account, and the day-trader's held-position exits see it.
 * Journal (autopilot-trades.jsonl): reserve_plan (every decision, holds included), reserve_order (the broker's
 * answer), reserve_skip (account or positions unreadable), reserve_error. The trade readers key on the event
 * entry / exit / session, so these rows never read as trades.
 */
const fs = require('fs');
const path = require('path');
const { reserveConfig, createReserve } = require('./two-sleeve/reserve');

const USER = 'local-owner';

/** The normalized reserve config from env, or null. A blank knob counts as absent: an empty
 *  TRADER_RESERVE_FUND_PCT must not read as pct 0, which sells the whole holding. */
function config(env = process.env) {
  const v = (k) => { const s = env[k]; return s == null || String(s).trim() === '' ? undefined : String(s).trim(); };
  const pct = v('TRADER_RESERVE_FUND_PCT');
  if (pct === undefined) return null;
  return reserveConfig({
    pct, symbol: v('TRADER_RESERVE_FUND_SYMBOL'), bandPct: v('TRADER_RESERVE_FUND_BAND_PCT'),
    minCashPct: v('TRADER_RESERVE_FUND_MIN_CASH_PCT'), window: v('TRADER_RESERVE_FUND_WINDOW'),
  });
}

/** The symbols the day-trader must leave alone and leave out of its risk counts: [fund] when configured, else []. */
function symbols(env = process.env) {
  const c = config(env);
  return c ? [c.symbol] : [];
}

function _stateFile(userId) {
  return require('./app-paths').dataPath('lantern-garage', 'trading', `reserve-fund.${userId}.state.json`);
}

// One reserve per user for the life of the process, so the once-a-session guard holds in memory even when the
// state file cannot be written. Each pass hands in its own facade; the reserve reads it through `ref`.
const _live = new Map();   // userId -> { key, reserve, ref }
function _reserveFor(userId, c, stateFile) {
  const key = JSON.stringify([c.symbol, c.pct, c.bandPct, c.minCashPct, c.window, stateFile]);
  let e = _live.get(userId);
  if (e && e.key === key) return e;
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch (_e) { /* fail-soft: the memory guard still holds */ }
  const ref = { facade: null, journal: () => {}, quote: null, cash: null };
  // THE CASH THE RESERVE PLANS WITH. IBKR's cash field is not trustworthy on its own: on stable's trading days
  // equity - cash - positions ran $0-351k (08-26..10-27), near 0 on idle days, so it reads LOW after the day's
  // buys; and the bridge reports an unreadable balance as 0. Equity minus the marked positions is the other
  // reading, but a positions dropout makes it read HIGH. The plan therefore sizes buys from the LOWER reading and
  // sells to restore the cash floor only when BOTH readings are under it (then by the smaller shortfall); when they
  // straddle the floor it holds. An exact 0 is unreadable: skip and retry at the next scan inside the window.
  const view = {
    getIBKRAccount: async (u) => {
      const a = await ref.facade.getIBKRAccount(u);
      if (!a || !(Number(a.equity) > 0) || Number(a.cash) === 0 || !Number.isFinite(Number(a.cash))) return null;
      const rows = await ref.facade.getIBKRPositions(u);
      if (!Array.isArray(rows)) return null;
      const invested = rows.reduce((s, p) => s + (Number(p.market_value) || (Number(p.qty) || 0) * (Number(p.current_price) || 0)), 0);
      const equity = Number(a.equity), broker = Number(a.cash), derived = equity - invested;
      const floor = (c.minCashPct / 100) * equity, lo = Math.min(broker, derived), hi = Math.max(broker, derived);
      ref.cash = { broker_cash: Math.round(broker), derived_cash: Math.round(derived) };
      return { ...a, cash: hi < floor ? hi : Math.max(lo, floor) };
    },
    getIBKRPositions: (u) => ref.facade.getIBKRPositions(u),
    placeIBKROrder: (u, o) => ref.facade.placeIBKROrder(u, o),
  };
  const reserve = createReserve({ cfg: c, facade: view, userId, stateFile,
    journal: (row) => ref.journal(row.event === 'reserve_plan' && ref.cash ? { ...row, ...ref.cash } : row),
    quote: (sym) => (ref.quote ? ref.quote(sym) : 0) });
  e = { key, reserve, ref };
  _live.set(userId, e);
  return e;
}

/**
 * Called from the autoscan pass right after the day-trader ran for an account, regular session only. Decides at
 * most once per ET session, at the first call inside the window. Returns null when there is no reserve for this
 * pass (unconfigured, another user, or not armed for entries); otherwise createReserve's maybeRun result.
 */
async function maybeRun({ facade, userId, at = Date.now(), journal = () => {}, quote = null, stateFile = null, env = process.env } = {}) {
  const c = config(env);
  if (!c || userId !== USER || env.TRADER_AUTO_EXECUTE !== '1' || !facade) return null;
  const e = _reserveFor(userId, c, stateFile || _stateFile(userId));
  Object.assign(e.ref, { facade, journal, quote });
  return e.reserve.maybeRun(at);
}

module.exports = { USER, config, symbols, maybeRun, _reset: () => _live.clear() };
