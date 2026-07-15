'use strict';

/**
 * stock-paper-ledger.js — a LOCAL paper-trading fill engine for equities/crypto.
 *
 * The trader's "PAPER" badge promised simulated trading, but with no broker
 * connected an order only hit the dry-run guard and produced nothing — the badge
 * was a promise the app couldn't keep. This is the missing piece: a virtual
 * per-user account that FILLS orders at the live feed price, tracks positions and
 * cash, and feeds the same normalized shapes the UI already reads (getAccount /
 * getPositions / placeOrder). No real money, no broker, no guard needed — it is
 * explicitly a simulator, labeled `source:'paper-sim'` everywhere.
 *
 * Precedence (routes): a connected IBKR or Alpaca account always wins; this is the
 * fallback so an unconnected user can still practice. Per-user JSON at rest.
 */

const fs = require('fs');
const path = require('path');
const yahoo = require('./market-data-yahoo');

const DIR = process.env.PAPER_LEDGER_DIR
  ? path.resolve(process.env.PAPER_LEDGER_DIR)
  : path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'paper');
const START_CASH = Number(process.env.PAPER_START_CASH) || 100000;   // virtual $100k

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId || 'guest')) + '.json'); }
function _load(userId) {
  try { return JSON.parse(fs.readFileSync(_file(userId), 'utf8')); }
  catch (_e) { return { cash: START_CASH, positions: {}, start_cash: START_CASH, created: new Date().toISOString() }; }
}
function _save(userId, led) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify(led), { mode: 0o600 });
}

// Live price for a symbol from the same keyless feed the charts use. Null if the
// feed can't price it — we NEVER fabricate a fill price.
async function _price(sym) {
  try {
    const q = (await yahoo.getQuotes([String(sym).toUpperCase()]))[0];
    return q && q.price > 0 ? q.price : null;
  } catch (_e) { return null; }
}

/** Mark positions to live prices; returns { positions[], equity, unrealized }. */
async function _mark(led) {
  const syms = Object.keys(led.positions || {});
  const prices = {};
  await Promise.all(syms.map(async (s) => { prices[s] = await _price(s); }));
  let mktValue = 0, unrealized = 0;
  const positions = syms.map((s) => {
    const p = led.positions[s];
    const last = prices[s] != null ? prices[s] : p.avg_entry_price;
    const value = last * p.qty;
    const upl = (last - p.avg_entry_price) * p.qty;
    mktValue += value; unrealized += upl;
    return {
      symbol: s, qty: p.qty, side: p.qty < 0 ? 'short' : 'long',
      avg_entry_price: Math.round(p.avg_entry_price * 100) / 100,
      current_price: Math.round(last * 100) / 100,
      market_value: Math.round(value * 100) / 100,
      unrealized_pl: Math.round(upl * 100) / 100,
      pnl_pct: p.avg_entry_price ? Math.round((last / p.avg_entry_price - 1) * 10000) / 100 : 0,
    };
  }).filter((p) => Math.abs(p.qty) > 0);
  return { positions, equity: led.cash + mktValue, unrealized };
}

/** Has this user ever placed a paper trade? (Used to decide the fallback tier.) */
function has(userId) { return fs.existsSync(_file(userId)); }

async function getAccount(userId) {
  const led = _load(userId);
  const m = await _mark(led);
  const day = m.equity - (led.start_cash || START_CASH);   // simple session P&L vs start
  return {
    account_id: 'PAPER-SIM',
    equity: Math.round(m.equity * 100) / 100,
    cash: Math.round(led.cash * 100) / 100,
    unrealized: Math.round(m.unrealized * 100) / 100,
    realized_today: 0,
    pnl_today: Math.round(day * 100) / 100,
    pnl_pct: (led.start_cash ? (day / led.start_cash) * 100 : 0),
    buying_power: Math.round(led.cash * 100) / 100,
    mode: 'paper',
    source: 'paper-sim',
  };
}

async function getPositions(userId) {
  const led = _load(userId);
  const m = await _mark(led);
  return { positions: m.positions, source: 'paper-sim' };
}

/** Fill an order into the virtual account at the live price. Market only for now
 *  (a limit is filled at its price if the market is through it, else at last). */
async function placeOrder(userId, { ticker, side, qty }) {
  const sym = String(ticker || '').toUpperCase();
  const q = Math.abs(Number(qty) || 0);
  const base = { order_id: null, ticker: sym, side, qty: q, type: 'market', dry: false, mode: 'paper', source: 'paper-sim' };
  if (!sym || !q) return { ...base, status: 'error', reason: 'symbol and positive qty required' };
  const px = await _price(sym);
  if (px == null) return { ...base, status: 'error', reason: `no live price for ${sym} — can't simulate a fill` };

  const led = _load(userId);
  const signed = String(side).toLowerCase() === 'sell' ? -q : q;
  const cur = led.positions[sym] || { qty: 0, avg_entry_price: px };
  const newQty = cur.qty + signed;

  // Cash + weighted average entry. Adding to a position averages the entry; reducing
  // or flipping realizes against cash at the fill price.
  led.cash -= signed * px;   // buy reduces cash, sell adds cash
  if (cur.qty === 0 || Math.sign(cur.qty) === Math.sign(newQty) && Math.abs(newQty) > Math.abs(cur.qty)) {
    // opening or adding in the same direction → weighted-average entry
    cur.avg_entry_price = ((cur.avg_entry_price * Math.abs(cur.qty)) + (px * q)) / (Math.abs(cur.qty) + q) || px;
  } else if (newQty !== 0 && Math.sign(newQty) !== Math.sign(cur.qty)) {
    // flipped through zero → new entry is the fill price
    cur.avg_entry_price = px;
  }
  cur.qty = newQty;
  if (newQty === 0) delete led.positions[sym]; else led.positions[sym] = cur;
  _save(userId, led);

  return { ...base, status: 'placed', order_id: 'paper-' + Date.now(), fill_price: Math.round(px * 100) / 100, reason: `simulated fill @ $${Math.round(px * 100) / 100}` };
}

/** Reset the virtual account (for a clean test run). */
function reset(userId) { try { fs.unlinkSync(_file(userId)); return true; } catch { return false; } }

module.exports = { has, getAccount, getPositions, placeOrder, reset, START_CASH };
