'use strict';

/**
 * house-paper-broker.js — every signed-in user's own practice trading account (#2546).
 *
 * THE GAP THIS CLOSES. The Free tier promises "your own paper-trading account". Today a user
 * only gets a personal account by completing Alpaca OAuth with an Alpaca account they already
 * own; otherwise `broker-facade.brokerFacadeFor()` returns null and the caller skips them, or
 * they land on the shared operator paper keys — one account for everyone, not "your own".
 *
 * WHY AN INTERNAL LEDGER (issue option B, not A or C). Option A (Alpaca Broker API sandbox)
 * needs a commercial Broker-API agreement and KYC rails to mint accounts — heavy machinery for
 * a practice account, and an external dependency on the signup path. Option C (walk the user
 * through creating their own Alpaca account) fails the acceptance criterion outright: it still
 * requires owning a brokerage account. Option B has no external dependency, is isolated per
 * user by construction, and works offline.
 *
 * It is also not a new subsystem: `kalshi-paper-ledger.js` already runs exactly this pattern
 * for Kalshi (append-only ledger, cash derived from it). This is the equities twin, and it
 * deliberately copies that module's core discipline:
 *
 *   CASH AND POSITIONS ARE DERIVED FROM THE APPEND-ONLY LEDGER, NEVER STORED.
 *
 * There is no mutable balance field to drift, double-spend, or corrupt under concurrent
 * writes. Replaying the file is the only way to know the account state, so the file IS the
 * account. A torn trailing line is skipped rather than throwing.
 *
 * SAFETY. This module places NO external orders — it has no broker client and makes no
 * network call except a read-only price quote. It cannot move real money, which is why it does
 * not consult `trading-guard` (the guard exists to stop real orders; there are none here).
 * Everything it returns is stamped `mode:'paper'`, `source:'house'` so no surface can mistake
 * it for a connected brokerage.
 *
 * FILL MODEL, stated rather than implied:
 *   - Market orders fill immediately at the live quote.
 *   - Limit orders rest, and are evaluated ON ACCESS (there is no background tick) — a resting
 *     order fills at its LIMIT price the first time a read observes the quote crossing it.
 *     Filling at the limit rather than the observed price is the conservative choice: it never
 *     credits the user with a better price than they asked for.
 *   - No partial fills, no slippage, no commission. This is a practice account for learning the
 *     surface, not a backtester — `experiments/` is where cost-realistic work belongs.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'paper');
const START_EQUITY = Number(process.env.HOUSE_PAPER_START_EQUITY) || 100000;

function _file(userId) {
  return path.join(DIR, encodeURIComponent(String(userId || 'default')) + '.jsonl');
}

/** Read the ledger. Tolerates a partially-written trailing line (crash mid-append). */
function _rows(userId) {
  try {
    const raw = fs.readFileSync(_file(userId), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_e) { /* torn write — skip */ }
    }
    return out;
  } catch (_e) { return []; }
}

function _append(userId, row) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(_file(userId), JSON.stringify(row) + '\n');
  return row;
}

/** Has this user ever been provisioned? Used to decide seeding, not to gate access. */
function exists(userId) {
  try { return fs.existsSync(_file(userId)); } catch (_e) { return false; }
}

/**
 * Provision the account. Idempotent — an existing ledger is left exactly as-is, so calling
 * this on every login can never reset someone's positions.
 */
function ensureAccount(userId, { startEquity = START_EQUITY } = {}) {
  if (exists(userId)) return { created: false };
  _append(userId, { type: 'open_account', ts: new Date().toISOString(), startEquity });
  return { created: true, startEquity };
}

function _startEquity(rows) {
  const open = rows.find((r) => r.type === 'open_account');
  return Number(open && open.startEquity) || START_EQUITY;
}

/**
 * Replay the ledger into { cash, positions, realized }. The single source of truth.
 * Positions are average-cost; a sell realizes P&L against the running average.
 */
function _replay(rows) {
  let cash = _startEquity(rows);
  let realized = 0;
  const pos = new Map(); // symbol -> { qty, avg }
  const realizedByDay = new Map();

  for (const r of rows) {
    if (r.type !== 'fill') continue;
    const sym = String(r.symbol || '').toUpperCase();
    const qty = Number(r.qty) || 0;
    const px = Number(r.price) || 0;
    if (!sym || qty <= 0 || px <= 0) continue;
    const cur = pos.get(sym) || { qty: 0, avg: 0 };

    if (r.side === 'buy') {
      cash -= qty * px;
      const total = cur.qty + qty;
      cur.avg = total > 0 ? ((cur.qty * cur.avg) + (qty * px)) / total : 0;
      cur.qty = total;
    } else {
      // Sell only what is held — the ledger is append-only, so a stale duplicate sell must
      // not be able to manufacture a short position out of nothing.
      const sold = Math.min(qty, cur.qty);
      if (sold <= 0) continue;
      cash += sold * px;
      const pnl = (px - cur.avg) * sold;
      realized += pnl;
      const day = String(r.ts || '').slice(0, 10);
      realizedByDay.set(day, (realizedByDay.get(day) || 0) + pnl);
      cur.qty -= sold;
      if (cur.qty <= 0) { cur.qty = 0; cur.avg = 0; }
    }
    pos.set(sym, cur);
  }
  return { cash, realized, realizedByDay, positions: pos };
}

/** Resting (unfilled, uncancelled) limit orders, newest last. */
function _resting(rows) {
  const filled = new Set();
  const cancelled = new Set();
  for (const r of rows) {
    if (r.type === 'fill' && r.orderId) filled.add(r.orderId);
    if (r.type === 'cancel' && r.orderId) cancelled.add(r.orderId);
  }
  return rows.filter((r) => r.type === 'order' && !filled.has(r.orderId) && !cancelled.has(r.orderId));
}

let _quoteFn = null;
/** Injectable for tests; defaults to the same feed the watchlist uses. */
function _quotes() {
  if (_quoteFn) return _quoteFn;
  return require('./market-data-yahoo').getQuotes;
}
function _setQuoteFn(fn) { _quoteFn = fn; }   // test seam

async function _priceMap(symbols) {
  const list = [...new Set(symbols.filter(Boolean).map((s) => String(s).toUpperCase()))];
  if (!list.length) return new Map();
  try {
    const rows = await _quotes()(list);
    const m = new Map();
    for (const q of rows || []) {
      const p = Number(q && q.price) || 0;
      if (p > 0) m.set(String(q.ticker).toUpperCase(), p);
    }
    return m;
  } catch (_e) { return new Map(); }
}

/**
 * Evaluate resting limit orders against the live quote and append any fills.
 * Called on access — see the fill-model note in the header.
 */
async function _sweepResting(userId, rows) {
  const resting = _resting(rows);
  if (!resting.length) return rows;
  const prices = await _priceMap(resting.map((o) => o.symbol));
  let filledAny = false;
  for (const o of resting) {
    const px = prices.get(String(o.symbol).toUpperCase());
    if (!px) continue;
    const limit = Number(o.limitPrice) || 0;
    if (!limit) continue;
    const crosses = o.side === 'buy' ? px <= limit : px >= limit;
    if (!crosses) continue;
    // Fill AT THE LIMIT, never at the better observed price.
    _append(userId, {
      type: 'fill', ts: new Date().toISOString(), orderId: o.orderId,
      side: o.side, symbol: o.symbol, qty: o.qty, price: limit, note: 'resting limit crossed',
    });
    filledAny = true;
  }
  return filledAny ? _rows(userId) : rows;
}

// ── The IBKR-flavored surface broker-facade.js dispatches to ────────────────────────────
// Method names match the facade contract exactly (see broker-facade.js) so this drops in
// beside the IBKR bridge and the Alpaca adapter with no call-site changes.

async function getAccount(userId) {
  ensureAccount(userId);
  const rows = await _sweepResting(userId, _rows(userId));
  const { cash, realized, realizedByDay, positions } = _replay(rows);
  const prices = await _priceMap([...positions.keys()]);
  let mkt = 0, unreal = 0;
  for (const [sym, p] of positions) {
    if (p.qty <= 0) continue;
    const px = prices.get(sym) || p.avg;      // no quote → mark at cost, never at zero
    mkt += px * p.qty;
    unreal += (px - p.avg) * p.qty;
  }
  const equity = cash + mkt;
  const today = new Date().toISOString().slice(0, 10);
  const realizedToday = realizedByDay.get(today) || 0;
  const start = _startEquity(rows);
  return {
    account_id: 'PAPER-' + String(userId || 'default').slice(0, 24),
    equity, cash,
    unrealized: unreal,
    realized_today: realizedToday,
    pnl_today: realizedToday + unreal,
    pnl_pct: equity ? ((equity - start) / start) * 100 : 0,
    buying_power: Math.max(0, cash),          // cash account: no margin in the practice account
    mode: 'paper',
    source: 'house',
    practice: true,
  };
}

async function getPositions(userId) {
  ensureAccount(userId);
  const rows = await _sweepResting(userId, _rows(userId));
  const { positions } = _replay(rows);
  const live = [...positions.entries()].filter(([, p]) => p.qty > 0);
  const prices = await _priceMap(live.map(([s]) => s));
  return {
    positions: live.map(([symbol, p]) => {
      const px = prices.get(symbol) || p.avg;
      return {
        symbol, ticker: symbol, qty: p.qty, position: p.qty,
        avg_price: p.avg, avg_cost: p.avg, market_price: px,
        market_value: px * p.qty,
        unrealized_pnl: (px - p.avg) * p.qty,
        unrealized_pnl_pct: p.avg ? ((px - p.avg) / p.avg) * 100 : 0,
        source: 'house',
      };
    }),
    source: 'house',
  };
}

async function getOpenOrders(userId) {
  ensureAccount(userId);
  const rows = await _sweepResting(userId, _rows(userId));
  return _resting(rows).map((o) => ({
    order_id: o.orderId, id: o.orderId, symbol: o.symbol, ticker: o.symbol,
    side: o.side, qty: o.qty, quantity: o.qty,
    order_type: 'limit', limit_price: o.limitPrice,
    status: 'open', created_at: o.ts, source: 'house',
  }));
}

async function getDayPnl(userId) {
  const a = await getAccount(userId);
  return { dailyPnl: a.pnl_today, unrealizedPnl: a.unrealized, realizedPnl: a.realized_today };
}

/**
 * Place a practice order. Returns the same {status, dry, ...} envelope the other adapters do.
 *
 * Rejections are explicit and honest — insufficient cash and overselling are refused rather
 * than silently clamped, because a practice account that lets you spend money you do not have
 * teaches the wrong thing.
 */
async function placeOrder(userId, order) {
  ensureAccount(userId);
  const o = order || {};
  const symbol = String(o.symbol || o.ticker || '').toUpperCase().trim();
  const side = String(o.side || o.action || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const qty = Math.floor(Number(o.qty || o.quantity || 0));
  const limitPrice = Number(o.limit_price || o.limitPrice || 0) || 0;
  const base = { broker: 'house', symbol, side, qty, mode: 'paper', practice: true };

  if (!symbol) return { ...base, status: 'error', dry: false, reason: 'missing symbol' };
  if (!(qty > 0)) return { ...base, status: 'error', dry: false, reason: 'quantity must be a positive whole number' };

  const rows = await _sweepResting(userId, _rows(userId));
  const { cash, positions } = _replay(rows);
  const orderId = 'hp_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);

  if (side === 'sell') {
    const held = (positions.get(symbol) || { qty: 0 }).qty;
    if (held < qty) {
      return { ...base, status: 'rejected', dry: false,
        reason: `you hold ${held} ${symbol}, cannot sell ${qty} (the practice account does not allow shorting)` };
    }
  }

  // Resting limit order — no fill now.
  if (limitPrice > 0) {
    if (side === 'buy' && cash < qty * limitPrice) {
      return { ...base, status: 'rejected', dry: false,
        reason: `insufficient practice cash: need $${(qty * limitPrice).toFixed(2)}, have $${cash.toFixed(2)}` };
    }
    _append(userId, { type: 'order', ts: new Date().toISOString(), orderId, side, symbol, qty, limitPrice });
    return { ...base, status: 'placed', order_id: orderId, dry: false, order_type: 'limit', limit_price: limitPrice };
  }

  // Market order — fill at the live quote.
  const px = (await _priceMap([symbol])).get(symbol) || 0;
  if (!(px > 0)) {
    return { ...base, status: 'error', dry: false, reason: `no live price for ${symbol} — cannot fill a practice market order` };
  }
  if (side === 'buy' && cash < qty * px) {
    return { ...base, status: 'rejected', dry: false,
      reason: `insufficient practice cash: need $${(qty * px).toFixed(2)}, have $${cash.toFixed(2)}` };
  }
  _append(userId, { type: 'fill', ts: new Date().toISOString(), orderId, side, symbol, qty, price: px, note: 'market' });
  return { ...base, status: 'placed', order_id: orderId, dry: false, filled_price: px, filled_qty: qty, order_type: 'market' };
}

async function cancelOrder(userId, orderId) {
  ensureAccount(userId);
  const open = _resting(_rows(userId)).some((o) => o.orderId === orderId);
  if (!open) return { status: 'error', reason: 'no such open practice order', order_id: orderId };
  _append(userId, { type: 'cancel', ts: new Date().toISOString(), orderId });
  return { status: 'cancelled', order_id: orderId, source: 'house' };
}

/** The journal: every ledger event for this user, newest first. Isolated per user by path. */
function journal(userId, { limit = 200 } = {}) {
  return _rows(userId).slice(-limit).reverse();
}

module.exports = {
  ensureAccount, exists, journal,
  getAccount, getPositions, getOpenOrders, getDayPnl, placeOrder, cancelOrder,
  START_EQUITY, _setQuoteFn, _replay, _resting, _file,
};
