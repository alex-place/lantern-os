'use strict';
/**
 * lib/overnight-book.js — the stable server's overnight book (2026-10-28).
 *
 * The engine's sleeve O (lib/two-sleeve/overnight-scan.js, #3741) for the server's day-trader: SPY, QQQ and SMH are
 * bought at the 15:55 print when the name's prior close is above its trailing 200-session mean, and sold at the 09:40
 * print of the next session; weekends are held. The scan, the windows and the gate are createOvernightScan's own. The
 * orders go straight through the account's facade, as the reserve fund's do (lib/reserve-fund.js). Measured on stable's
 * replay before this module existed (ledger tier1-stable-plus-overnight-sleeve-43-windows, 3 names x 5.5 %): +0.042 %/wk
 * over stable alone, Sharpe-like 0.41 -> 0.69, better on both surfaces; the price is the overnight gap (worst week
 * -4.89 vs -4.09).
 *
 *   - One owner per name. The book never buys a name the account already holds at 15:55 (the day-trader's carry).
 *     While the book holds a name, the day-trader leaves it alone: auto-trader adds partition().symbols to every pass's
 *     exclude set and keeps those rows out of its slot, bucket, slot_util and re-protect counts, out of its snapshot
 *     tells and book tracking, and out of its fill reconciliation (partition().sells). The book's notional DOES count
 *     toward the day-trader's gross cap, and the book buys only into the room the cap leaves, so the two together stay
 *     under TRADER_MAX_GROSS_PCT (the operator's cash floor, 10-28).
 *   - A name stays the book's from its buy until two positions reads in a row show it gone, so the morning sale is
 *     never read by the day-trader as a feed dropout or an external close. A sold name also waits for the broker to
 *     price its sale, at most FILL_READS more reads.
 *   - Size: TRADER_OVERNIGHT_BOOK_PCT of equity per name in whole shares, at most the room under the gross cap. No stop:
 *     the overnight hold is the edge, and a resting stop would sell the open's gap (measured: ext-hours stops cost most
 *     of the sleeve's return).
 *   - Only the operator's book (local-owner), only from an instance armed for entries (TRADER_AUTO_EXECUTE=1), regular-
 *     session passes only. One buy attempt per name per session; a sale is sent once per session, again only when the
 *     broker refused it (at most three tries).
 *
 * Config (env): TRADER_OVERNIGHT_BOOK_PCT absent, blank or not a number in 0..33 = off (names the book still holds
 * become ordinary longs of the account). 0 = no new buys while the held names are still sold at the next sell window
 * (the unwind). TRADER_OVERNIGHT_BOOK_SYMBOLS (default SPY,QQQ,SMH).
 * Journal (autopilot-trades.jsonl): overnight_book_buy / overnight_book_sell (the order and the broker's answer),
 * overnight_book_skip (a name not bought, and why), overnight_book_gone (a held name the broker no longer shows),
 * overnight_book_error. The trade readers key on the event entry / exit / session, so these rows never read as trades.
 * The px on a buy or sell row is the quote the order went in at. The sale's result is on the gone row of a sold name,
 * priced by the broker (2026-10-29: the first sale's P&L could only be estimated from those quotes): fill_px and
 * filled_qty from the sale's own order status, cost_px = the position's average price at the sale (the book's own buy
 * fills, one owner per name; the buy quote when the broker reported none, see cost_from), ret_pct and pnl against it.
 * A sale the broker never priced goes with fill_px null and fill_why.
 */
const fs = require('fs');
const path = require('path');
const { createOvernightScan, ENTRY_BAR, SELL_BAR } = require('./two-sleeve/overnight-scan');
const { etOf } = require('./trend-shadow');
const { closeOffset } = require('./market-calendar');

const USER = 'local-owner';
const OWNER = 'OVERNIGHT_BOOK';
const MAX_PCT = 33;                       // a third of equity per name: the engine book's full size
const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'SMH'];
const CLOSE_MIN = 960;                    // 16:00 ET
const SELL_TRIES = 3;
const GONE_READS = 2;
const FILL_READS = 3;                     // more reads a sold name waits for the broker to price its sale
const up = (s) => String(s || '').trim().toUpperCase();
const round = (x, d = 4) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);

/** The normalized config from env, or null when the book is off. A blank knob counts as absent. */
function config(env = process.env) {
  const v = (k) => { const s = env[k]; return s == null || String(s).trim() === '' ? undefined : String(s).trim(); };
  const raw = v('TRADER_OVERNIGHT_BOOK_PCT');
  if (raw === undefined) return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > MAX_PCT) return null;
  const symbols = [...new Set((v('TRADER_OVERNIGHT_BOOK_SYMBOLS') || DEFAULT_SYMBOLS.join(',')).split(',').map(up).filter(Boolean))];
  return symbols.length ? { pct, symbols } : null;
}

/** The day-trader's gross cap as auto-trader reads it (TRADER_MAX_GROSS_PCT, default 80; 0 or >= 100 = no cap). */
function grossCapPct(env = process.env) {
  const g = parseFloat(env.TRADER_MAX_GROSS_PCT);
  const pct = Number.isFinite(g) ? g : 80;
  return pct > 0 && pct < 100 ? pct : null;
}

function _stateFile(userId) {
  return require('./app-paths').dataPath('lantern-garage', 'trading', `overnight-book.${userId}.state.json`);
}

// One book per user for the life of the process; the state file carries it across restarts.
// state = { held: { SYM: { qty, day, px, at, orderId, gone, sell: { day, at, qty, orderId, ok, tries, cost } } },
//           tried: { day, syms: [] }, sells: [{ symbol, orderId, qty, at }] (the last 20, for the fill filter) }
const _books = new Map();   // userId -> { stateFile, state, scan, scanKey }
function _book(userId, stateFile = null) {
  let b = _books.get(userId);
  if (b && (!stateFile || b.stateFile === stateFile)) return b;   // the process's book, whoever asks
  const file = stateFile || _stateFile(userId);
  let state = { held: {}, tried: { day: null, syms: [] }, sells: [] };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') state = { ...state, ...j }; } catch (_e) { /* first run */ }
  if (!state.held || typeof state.held !== 'object') state.held = {};
  if (!Array.isArray(state.sells)) state.sells = [];
  b = { stateFile: file, state, scan: null, scanKey: null };
  _books.set(userId, b);
  return b;
}
function _save(b) {
  try { fs.mkdirSync(path.dirname(b.stateFile), { recursive: true }); fs.writeFileSync(b.stateFile, JSON.stringify(b.state)); }
  catch (_e) { /* fail-soft: the in-memory state still holds for this process */ }
}

/**
 * What the day-trader must leave to the book for this account: { symbols, since: { SYM: buy ms }, sells: [...] }.
 * Empty when the book is off or the account is not the operator's. Cheap: memory after the first read.
 */
function partition(userId, { env = process.env, stateFile = null } = {}) {
  const none = { symbols: [], since: {}, sells: [] };
  if (userId !== USER || !config(env)) return none;
  const b = _book(userId, stateFile);
  const since = {};
  for (const [s, h] of Object.entries(b.state.held)) since[s] = Number(h.at) || 0;
  return { symbols: Object.keys(b.state.held), since, sells: b.state.sells.slice() };
}

const _ok = (res) => !!res && res.status !== 'error' && res.status !== 'needs_confirmation' && !res.error && !res.dry;
const _orderId = (res) => (res ? (res.order_id ?? res.orderId ?? res.id ?? null) : null);

/**
 * The sale as the broker priced it, from the order's own status (the per-order read answers for any id the book names,
 * listed in the orders feed or not): { px, qty } once filled; { why } while it is not; { why, final } when this broker
 * or this sale cannot be priced at all, so there is nothing to wait for.
 */
async function _saleFill(facade, userId, orderId) {
  if (!orderId) return { why: 'no order id', final: true };
  if (typeof facade.getIBKROrderStatus !== 'function') return { why: 'no order status on this broker', final: true };
  const st = await Promise.resolve(facade.getIBKROrderStatus(userId, orderId)).catch(() => null);
  const px = Number(st && st.avgPrice) || 0;
  if (st && /fill/i.test(String(st.status || '')) && px > 0) return { px, qty: Number(st.filledQty) > 0 ? Number(st.filledQty) : null };
  return { why: st ? `order ${st.status || 'status unknown'}` : 'order status unreadable' };
}

/** The gone row's sale fields: the broker's fill against what the book paid (cost_from says which price that was). */
function _saleFields(h, fill) {
  const fromPosition = Number(h.sell.cost) > 0;
  const cost = fromPosition ? Number(h.sell.cost) : Number(h.px) > 0 ? Number(h.px) : null;
  const base = { order_id: h.sell.orderId, cost_px: round(cost), cost_from: fromPosition ? 'position' : 'buy quote' };
  if (!fill.px) return { ...base, fill_px: null, fill_why: fill.why };
  const qty = fill.qty || Number(h.sell.qty) || Number(h.qty);
  return { ...base, fill_px: round(fill.px), filled_qty: qty,
    ret_pct: cost ? round(100 * (fill.px / cost - 1)) : null, pnl: cost ? round((fill.px - cost) * qty, 2) : null };
}

/**
 * Called from the autoscan pass right after the day-trader (and the reserve fund) ran for an account, regular session
 * only. Outside 15:55-16:00 ET (12:55-13:00 on an early close), and outside the sell window while the book holds
 * nothing, it returns at once without a market-data read. Returns null when there is no book for this pass.
 */
async function maybeRun({ facade, userId, at = Date.now(), journal = () => {}, getBars = null, quote = null, stateFile = null, env = process.env } = {}) {
  const c = config(env);
  if (!c || userId !== USER || env.TRADER_AUTO_EXECUTE !== '1' || !facade || typeof getBars !== 'function') return null;
  const b = _book(userId, stateFile);
  const e = etOf(at);
  const off = closeOffset(e.day);
  const nearEntry = e.min >= ENTRY_BAR + 5 - off && e.min < CLOSE_MIN - off;
  const holding = Object.keys(b.state.held).length > 0;
  const sellHours = holding && e.min >= SELL_BAR + 5 && e.min < CLOSE_MIN - off;
  if (!nearEntry && !sellHours) return { ran: false, why: 'outside the windows' };

  const raw = await Promise.resolve(facade.getIBKRPositions(userId)).catch(() => null);
  if (!raw || raw.unreadable) { journal({ event: 'overnight_book_skip', symbol: '*', why: 'positions unreadable' }); return { ran: false, why: 'unreadable' }; }
  const rows = Array.isArray(raw) ? raw : (raw.positions || []);
  const qtyOf = {}, mvOf = {}, paid = {};
  for (const p of rows) {
    const s = up(p && (p.symbol || p.ticker)); if (!s) continue;
    const q = Number(p.qty ?? p.quantity) || 0;
    qtyOf[s] = (qtyOf[s] || 0) + q;
    mvOf[s] = (mvOf[s] || 0) + Math.abs(Number(p.market_value) || q * (Number(p.current_price) || 0));
    const avg = Number(p.avg_entry_price ?? p.avg_fill_price) || 0;   // the broker's average price of the position
    if (q > 0 && avg > 0) { const w = paid[s] || (paid[s] = { q: 0, v: 0 }); w.q += q; w.v += q * avg; }
  }

  // Held names the broker no longer shows: the sale filled, the buy never did, or the operator closed it. Two reads in
  // a row before the name is released (a single empty read can be a feed dropout); a buy placed this session is kept
  // until the sell window, because the positions feed lags a fill. A sold name is released with its sale priced by the
  // broker; while the broker has not priced it yet the name waits, at most FILL_READS more reads.
  let changed = false;
  for (const [s, h] of Object.entries(b.state.held)) {
    if ((qtyOf[s] || 0) > 0) { if (h.gone) { h.gone = 0; changed = true; } continue; }
    if (!h.sell && h.day === e.day) continue;
    h.gone = (h.gone || 0) + 1; changed = true;
    if (h.gone < GONE_READS) continue;
    const sold = !!(h.sell && h.sell.ok);
    const fill = sold ? await _saleFill(facade, userId, h.sell.orderId) : null;
    if (fill && !fill.px && !fill.final && h.gone < GONE_READS + FILL_READS) continue;
    journal({ event: 'overnight_book_gone', symbol: s, qty: h.qty, bought_day: h.day, sold, why: sold ? 'sold' : 'not held at the broker',
      ...(sold ? _saleFields(h, fill) : {}) });
    delete b.state.held[s];
  }
  if (changed) _save(b);

  const key = c.symbols.join(',');
  if (!b.scan || b.scanKey !== key) { b.scan = createOvernightScan({ symbols: c.symbols, getBars }); b.scanKey = key; }
  const res = await b.scan.scan(at);
  const window = res && res.overnight ? res.overnight.window : null;
  const sig = {}; for (const x of (res && res.signals) || []) sig[x.symbol] = x;
  const read = {}; for (const x of (res && res.overnight && res.overnight.reads) || []) read[x.symbol] = x;
  const out = { ran: true, window, bought: [], sold: [] };

  if (window === 'sell') {
    for (const [s, h] of Object.entries(b.state.held)) {
      const q = qtyOf[s] || 0;
      if (!(q > 0)) continue;
      if (h.sell && h.sell.day === e.day && (h.sell.ok || h.sell.tries >= SELL_TRIES)) continue;
      const qty = Math.min(q, Number(h.qty) || q);
      const px = sig[s] ? Number(sig[s].price) || null : null;
      const cost = paid[s] ? paid[s].v / paid[s].q : null;   // what the book paid, as the broker reports it
      const order = { ticker: s, side: 'sell', qty, type: 'market', timeInForce: 'day', refPrice: px, acceptWarnings: true, _owner: OWNER };
      const r = await Promise.resolve(facade.placeIBKROrder(userId, order)).catch((err) => ({ status: 'error', reason: String((err && err.message) || err) }));
      const ok = _ok(r), orderId = _orderId(r);
      const tries = h.sell && h.sell.day === e.day ? (h.sell.tries || 0) + 1 : 1;
      h.sell = { day: e.day, at, qty, orderId, ok, tries, cost: round(cost) };
      if (ok) { b.state.sells.push({ symbol: s, orderId, qty, at }); b.state.sells = b.state.sells.slice(-20); out.sold.push(s); }
      _save(b);
      journal({ event: 'overnight_book_sell', symbol: s, qty, bought_day: h.day, entry_px: round(h.px), cost_px: round(cost), px: round(px),
        ret_pct: h.px > 0 && px > 0 ? round(100 * (px / h.px - 1)) : null, ok, status: r && r.status, orderId, tries,
        reason: r && r.reason, warnings: (r && r.warnings) || undefined });
    }
  }

  if (window === 'entry' && c.pct > 0) {
    if (b.state.tried.day !== e.day) b.state.tried = { day: e.day, syms: [] };
    const todo = c.symbols.filter((s) => !b.state.tried.syms.includes(s) && !b.state.held[s]);
    if (todo.length) {
      const acct = await Promise.resolve(facade.getIBKRAccount(userId)).catch(() => null);
      const equity = acct ? Number(acct.equity) : 0;
      if (!(equity > 0)) { journal({ event: 'overnight_book_skip', symbol: '*', why: 'account unreadable' }); return out; }
      // The room under the day-trader's gross cap. The reserve fund is the cash the cap keeps, not exposure.
      const fund = new Set(require('./reserve-fund').symbols(env).map(up));
      let gross = 0; for (const [s, mv] of Object.entries(mvOf)) if (!fund.has(s)) gross += mv;
      const cap = grossCapPct(env);
      let room = cap == null ? Infinity : (cap / 100) * equity - gross;
      for (const s of todo) {
        const x = sig[s], rd = read[s] || {};
        const gate = rd.gate ? { above: rd.gate.above, prior: rd.gate.prior, mean: rd.gate.mean, n: rd.gate.n } : null;
        const skip = (why) => { b.state.tried.syms.push(s); journal({ event: 'overnight_book_skip', symbol: s, why, gate, bar: rd.bar || null }); };
        // A name whose own 15:50 bar is not read yet (feed lag) is decided by the next pass inside the window.
        if (!x || !x.decision_context || x.decision_context.overnight_window !== 'entry') continue;
        if (x.direction !== 'BULLISH') { skip(rd.why || 'below the trend'); continue; }
        if ((qtyOf[s] || 0) !== 0) { skip('held by the day-trader'); continue; }
        let px = Number(x.price) || 0;
        if (typeof quote === 'function') { const qp = Number(await Promise.resolve(quote(s)).catch(() => 0)) || 0; if (qp > 0) px = qp; }
        if (!(px > 0)) { skip('no price'); continue; }
        const want = (c.pct / 100) * equity;
        const qty = Math.floor(Math.min(want, Math.max(0, room)) / px);
        if (!(qty >= 1)) { skip(`no room under the gross cap (${cap}% of equity)`); continue; }
        b.state.tried.syms.push(s); _save(b);   // one attempt a session, whatever the broker answers
        const order = { ticker: s, side: 'buy', qty, type: 'market', timeInForce: 'day', refPrice: px, equity, acceptWarnings: true, _owner: OWNER };
        const r = await Promise.resolve(facade.placeIBKROrder(userId, order)).catch((err) => ({ status: 'error', reason: String((err && err.message) || err) }));
        const ok = _ok(r), orderId = _orderId(r);
        if (ok) { b.state.held[s] = { qty, day: e.day, px, at, orderId }; room -= qty * px; out.bought.push(s); _save(b); }
        journal({ event: 'overnight_book_buy', symbol: s, qty, px: round(px), notional: Math.round(qty * px), equity: Math.round(equity),
          pct: c.pct, gross_before: Math.round(gross), cap_pct: cap, gate, bar: rd.bar || null, ok, status: r && r.status, orderId,
          reason: r && r.reason, warnings: (r && r.warnings) || undefined });
      }
    }
  }
  return out;
}

module.exports = { USER, OWNER, MAX_PCT, config, grossCapPct, partition, maybeRun, _reset: () => _books.clear() };
