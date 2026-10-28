'use strict';
/**
 * lib/two-sleeve/reserve.js — the engine's cash reserve (2026-10-27).
 *
 * The engine's book is mostly cash, and a paper account pays no interest on it. At live size the replay
 * of the live design held a median 17 % of equity overnight on the nights it held anything, 41 % at the
 * 99th percentile and 58 % at most (2016-2026). The reserve parks a fixed share of equity in ONE cash-like
 * fund and leaves it alone. The intended fund is BOXX (Alpha Architect 1-3 Month Box ETF): its T-bill
 * yield accrues in its PRICE (no regular distributions), so a paper account that credits no dividends
 * still earns it. SGOV and BIL pay theirs as monthly dividends instead.
 *
 *   - Ownership: the symbol is RESERVED to the pseudo-owner RESERVE (lib/two-sleeve/ownership.js), so no
 *     sleeve sees, adopts, protects or sells it, and the runner adds it to every brain's excludeSymbols.
 *     Unreserved, the default sleeve S would adopt it and its exits (intraday, de-carry, weekend flat)
 *     would sell it.
 *   - Cadence: at most one decision per session, at the first regular-session tick inside a quiet window
 *     (default 12:00-12:30 ET: the leg blocks entries 11:05-14:35; C and O act at 15:50-15:55 and 09:40).
 *     A relaunch inside the window does not decide twice (state file).
 *   - Size: target = pct of equity. It trades only when the holding is off target by more than bandPct of
 *     the target, and a buy never takes cash below minCashPct of equity. When cash is already below that
 *     floor (the sleeves are holding more than usual) it SELLS enough of the fund to restore it, inside
 *     the band or not. pct 0 sells the whole holding: to unwind, set pct 0 for one session, then remove
 *     the block (a removed block leaves the holding owned by RESERVE and unmanaged).
 *   - Orders: whole shares, market, day; priced at the broker's mark when held, else a fresh quote. Each
 *     order carries that price (refPrice), the equity it was sized from and reserve: true, so the IBKR
 *     order guard (lib/trading-guard.js) caps it as a reserve order, not as a trader's position, and
 *     acceptWarnings: true, as the day-trader's own entries do (IBKR's size notices).
 *
 * Config (two-sleeve config.json, top level; absent, or pct not a number in 0..90 = no reserve):
 *   "reserve": { "symbol": "BOXX", "pct": 30, "bandPct": 10, "minCashPct": 5, "window": "12:00-12:30" }
 * Journal rows (engine.jsonl): reserve_ready (at engine start), reserve_plan (every decision, holds
 * included), reserve_order (the broker's answer), reserve_skip (account or positions unreadable).
 * The stable server's day-trader runs the same reserve from env knobs: lib/reserve-fund.js.
 */
const fs = require('fs');

const OWNER = 'RESERVE';
const DEFAULTS = { symbol: 'BOXX', bandPct: 10, minCashPct: 5, window: '12:00-12:30' };
const MAX_PCT = 90;   // never park the whole book

const _ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** ET calendar day and minute of day for an epoch ms. */
function etOf(ms) {
  const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
/** "HH:MM-HH:MM" -> { from, to } in ET minutes, or null. */
function parseWindow(w) {
  const m = String(w || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2]), to = Number(m[3]) * 60 + Number(m[4]);
  return to > from ? { from, to } : null;
}

/** The normalized reserve config, or null when there is no reserve. */
function reserveConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pct = Number(raw.pct);
  if (raw.pct == null || !Number.isFinite(pct) || pct < 0 || pct > MAX_PCT) return null;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    symbol: String(raw.symbol || DEFAULTS.symbol).toUpperCase(),
    pct,
    bandPct: num(raw.bandPct, DEFAULTS.bandPct),
    minCashPct: num(raw.minCashPct, DEFAULTS.minCashPct),
    window: parseWindow(raw.window) ? raw.window : DEFAULTS.window,
    win: parseWindow(raw.window) || parseWindow(DEFAULTS.window),
  };
}

/**
 * The pure decision. `qty` = whole shares held (0 when flat), `price` = the price to size with.
 * Returns { action: 'buy' | 'sell' | 'hold', qty, target, value, cashAfter, why }.
 */
function planReserve(cfg, { equity, cash, qty = 0, price }) {
  const out = { action: 'hold', qty: 0, target: 0, value: 0, cashAfter: cash, why: '' };
  if (!(Number(equity) > 0) || !Number.isFinite(Number(cash))) return { ...out, why: 'account unreadable' };
  if (!(Number(price) > 0)) return { ...out, why: 'no price' };
  const held = Math.max(0, Math.floor(Number(qty) || 0));
  const value = held * price, target = (cfg.pct / 100) * equity, floor = (cfg.minCashPct / 100) * equity;
  Object.assign(out, { target, value });
  // cash under the floor comes first: the sleeves need it more than the reserve does
  if (cash < floor && held > 0) {
    const q = Math.min(held, Math.ceil((floor - cash) / price));
    return { ...out, action: 'sell', qty: q, cashAfter: cash + q * price, why: `cash ${Math.round(cash)} under the floor ${Math.round(floor)}` };
  }
  if (cfg.pct === 0) return held > 0 ? { ...out, action: 'sell', qty: held, cashAfter: cash + value, why: 'pct 0: unwind' } : { ...out, why: 'pct 0, nothing held' };
  const band = (cfg.bandPct / 100) * target;
  if (Math.abs(value - target) <= band) return { ...out, why: `within the band (${Math.round(value)} vs ${Math.round(target)} +- ${Math.round(band)})` };
  if (value > target) {
    const q = Math.min(held, Math.floor((value - target) / price));
    return q > 0 ? { ...out, action: 'sell', qty: q, cashAfter: cash + q * price, why: `above target by ${Math.round(value - target)}` } : { ...out, why: 'excess under one share' };
  }
  const room = cash - floor;   // a buy never takes cash below the floor
  const q = Math.floor(Math.min(target - value, room) / price);
  if (q <= 0) return { ...out, why: room <= 0 ? `no cash above the floor (${Math.round(cash)} vs ${Math.round(floor)})` : 'shortfall under one share' };
  return { ...out, action: 'buy', qty: q, cashAfter: cash - q * price, why: `below target by ${Math.round(target - value)}` };
}

/**
 * The runner's reserve. maybeRun(at) is called after each regular-session engine tick and decides at most
 * once per ET day, at the first call inside the window. `quote(symbol)` -> price is used only when the fund
 * is not held. Returns null when the config has no reserve. `ownership` is optional: without one (the stable
 * server, whose day-trader is told to leave the fund alone through excludeSymbols) nothing is claimed.
 */
function createReserve({ cfg, facade, ownership = null, journal = () => {}, quote = null, userId, stateFile = null, now = () => Date.now() } = {}) {
  const c = reserveConfig(cfg);
  if (!c) return null;
  let state = { lastDay: null };
  if (stateFile) { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (j && typeof j === 'object') state = { ...state, ...j }; } catch (_e) { /* first run */ } }
  const save = () => { if (!stateFile) return; try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_e) { /* fail-soft: at worst one more decision today */ } };
  async function maybeRun(at = now()) {
    const e = etOf(at);
    if (e.min < c.win.from || e.min >= c.win.to) return { ran: false, why: 'outside the window' };
    if (state.lastDay === e.day) return { ran: false, why: 'already decided today' };
    const acct = await Promise.resolve(facade.getIBKRAccount(userId)).catch(() => null);
    const raw = await Promise.resolve(facade.getIBKRPositions(userId)).catch(() => null);
    if (!acct || !(Number(acct.equity) > 0) || !raw || raw.unreadable) {
      journal({ event: 'reserve_skip', symbol: c.symbol, why: 'account or positions unreadable' });
      return { ran: false, why: 'unreadable' };   // the next tick inside the window tries again
    }
    const rows = Array.isArray(raw) ? raw : (raw.positions || []);
    const pos = rows.find((p) => String((p && (p.symbol || p.ticker)) || '').toUpperCase() === c.symbol);
    const qty = pos ? Number(pos.qty || pos.quantity || 0) : 0;
    let price = pos ? Number(pos.current_price || pos.price || 0) : 0;
    if (!(price > 0) && typeof quote === 'function') price = Number(await Promise.resolve(quote(c.symbol)).catch(() => 0)) || 0;
    const plan = planReserve(c, { equity: Number(acct.equity), cash: Number(acct.cash), qty, price });
    state.lastDay = e.day; save();   // one decision a day, whatever the broker answers
    journal({ event: 'reserve_plan', symbol: c.symbol, pct: c.pct, equity: Number(acct.equity), cash: Number(acct.cash), held: qty, price, ...plan });
    if (plan.action === 'hold') return { ran: true, plan };
    // acceptWarnings: IBKR stops a ~3,000-share buy at its precautionary "Size Limit" notice, as it does the
    // trader's entries, which accept it by design (auto-trader, 2026-08-10). Alpaca ignores the field.
    const order = { ticker: c.symbol, side: plan.action, qty: plan.qty, type: 'market', timeInForce: 'day', refPrice: price, equity: Number(acct.equity), reserve: true, acceptWarnings: true, _owner: OWNER };
    const res = await Promise.resolve(facade.placeIBKROrder(userId, order))
      .catch((err) => ({ status: 'error', reason: String((err && err.message) || err) }));
    // needs_confirmation = IBKR stopped at an order warning: nothing was placed.
    const ok = !!res && res.status !== 'error' && res.status !== 'needs_confirmation' && !res.error && !res.dry;
    const orderId = res ? (res.order_id ?? res.orderId ?? res.id ?? null) : null;
    if (ok && ownership) {
      if (plan.action === 'buy') ownership.claim(c.symbol, OWNER);
      if (orderId != null) ownership.tagOrder(orderId, c.symbol, OWNER);
    }
    journal({ event: 'reserve_order', symbol: c.symbol, side: plan.action, qty: plan.qty, ok, status: res && res.status, orderId, reason: res && res.reason, warnings: (res && res.warnings) || undefined });
    return { ran: true, plan, res, ok };
  }
  return { cfg: c, owner: OWNER, maybeRun, state: () => ({ ...state }) };
}

module.exports = { OWNER, DEFAULTS, MAX_PCT, etOf, parseWindow, reserveConfig, planReserve, createReserve };
