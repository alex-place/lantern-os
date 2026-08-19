'use strict';

/**
 * csp-shadow.js — the CSP SHADOW BOOK (#3219). Observer only: NEVER places orders.
 *
 * Value-per-position research (2026-08-08): a $70k stock position capturing
 * ~$500/trade is thin. The limit-entry route was lab-gated and rejected
 * (adverse selection: the signals that never dip to the limit are the best
 * snapbacks). The surviving mechanism is expressing the SAME washout as a
 * cash-secured put — IBS fires exactly when IV is elevated, so the premium is
 * the monetized fear; it wins on bounce AND chop, and assignment is a better
 * basis while being PAID to wait.
 *
 * This module runs that comparison honestly before any capital moves: on every
 * live IBS entry the day-trader takes, record the paper CSP leg it COULD have
 * sold (nearest weekly at/just below the washout price, real quoted bid,
 * conservative), then resolve it at expiry against the real underlying price.
 * The journal pairs each shadow leg with the stock trade's signal so the
 * per-position comparison is per-signal, not aggregate hand-waving.
 *
 * Journal (append-only JSONL, data/lantern-garage/trading/csp-shadow.jsonl):
 *   { event:'csp_shadow_open', id, ts, symbol, signal_price, stock_qty,
 *     contracts, strike, expiration, premium, bid, ask, source }
 *   { event:'csp_shadow_close', id, ts, symbol, strike, expiration, contracts,
 *     premium, underlying_at_resolve, outcome:'expired'|'assigned', pnl }
 *   { event:'csp_shadow_skip', ts, symbol, reason }   — chain unavailable etc.
 *
 * P&L convention (per resolved leg, dollars):
 *   expired  (underlying >= strike): + premium * 100 * contracts
 *   assigned (underlying <  strike): + premium*100*c − (strike − underlying)*100*c
 * Resolution uses the CURRENT quote on the first scan at/after expiry — an
 * approximation of the expiry close, labeled as such in the row (resolve_lag_s).
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.CSP_SHADOW_FILE
  ? path.resolve(process.env.CSP_SHADOW_FILE)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'csp-shadow.jsonl');

// In-memory index of the journal (small file; loaded once, appended after).
let _loaded = false;
const _open = new Map();     // id -> open row
const _closedIds = new Set();

function _load() {
  if (_loaded) return;
  _loaded = true;
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch (_e) { return; }
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch (_e) { continue; }
    if (r.event === 'csp_shadow_open' && r.id) _open.set(r.id, r);
    if (r.event === 'csp_shadow_close' && r.id) { _closedIds.add(r.id); _open.delete(r.id); }
  }
}

function _append(row) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  } catch (_e) { /* the shadow book must never break trading */ }
}

/** Pick the shadow contract from a normalized chain: the nearest expiry 2–11
 *  calendar days out, at the highest put strike <= the signal price, with a
 *  real bid. Returns null (with a reason) when no such contract exists. */
function pickContract(rows, signalPrice, nowMs) {
  if (!Array.isArray(rows) || !rows.length) return { contract: null, reason: 'empty chain' };
  const MIN_MS = 2 * 86400e3, MAX_MS = 11 * 86400e3;
  const puts = rows.filter((r) => r && r.type === 'put'
    && Number(r.strike) > 0 && Number(r.strike) <= signalPrice
    && Number(r.bid) > 0
    && r.expiration && (() => { const t = Date.parse(r.expiration + 'T21:00:00Z'); return t - nowMs >= MIN_MS && t - nowMs <= MAX_MS; })());
  if (!puts.length) return { contract: null, reason: 'no put with bid>0, strike<=price, expiry 2-11d' };
  // nearest expiry first, then highest strike (closest below the washout)
  puts.sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : Number(b.strike) - Number(a.strike)));
  return { contract: puts[0], reason: null };
}

/** Same-notional sizing: one contract controls 100 shares. */
function contractsFor(stockQty) {
  return Math.max(1, Math.round((Number(stockQty) || 0) / 100));
}

/** Resolution math — exported pure for tests. */
function resolvePnl({ premium, strike, contracts }, underlying) {
  const c = Number(contracts) || 1;
  const prem = Number(premium) * 100 * c;
  if (underlying >= strike) return { outcome: 'expired', pnl: +prem.toFixed(2) };
  return { outcome: 'assigned', pnl: +(prem - (strike - underlying) * 100 * c).toFixed(2) };
}

/**
 * Record the shadow leg for a live entry. Fetches the chain itself (fail-soft);
 * pass opts.chain in tests to stay offline.
 */
async function onEntry({ symbol, price, qty, ts }, opts = {}) {
  if (process.env.TRADER_CSP_SHADOW === '0') return null;
  _load();
  const sym = String(symbol || '').toUpperCase();
  const now = ts || Date.now();
  let chain = opts.chain;
  try {
    if (!chain) chain = await require('./options-data').getOptionsChain(sym);
  } catch (e) { chain = { available: false, reason: String(e.message || e) }; }
  if (!chain || !chain.available) {
    _append({ event: 'csp_shadow_skip', ts: new Date(now).toISOString(), symbol: sym, reason: (chain && chain.reason) || 'chain unavailable' });
    return null;
  }
  const { contract, reason } = pickContract(chain.rows || [], Number(price), now);
  if (!contract) {
    _append({ event: 'csp_shadow_skip', ts: new Date(now).toISOString(), symbol: sym, reason });
    return null;
  }
  const row = {
    event: 'csp_shadow_open',
    id: `${sym}-${contract.expiration}-${contract.strike}-${now}`,
    ts: new Date(now).toISOString(),
    symbol: sym,
    signal_price: Number(price),
    stock_qty: Number(qty) || 0,
    contracts: contractsFor(qty),
    strike: Number(contract.strike),
    expiration: contract.expiration,
    premium: Number(contract.bid),          // conservative: assume filled at bid
    bid: Number(contract.bid), ask: Number(contract.ask) || null,
    source: chain.source || null,
  };
  _open.set(row.id, row);
  _append(row);
  return row;
}

/**
 * Resolve every open leg whose expiry has passed, using getPrice(sym) →
 * number|null for the underlying. Call once per scan; cheap when nothing is due.
 */
async function resolveDue(getPrice, nowMs = Date.now()) {
  if (process.env.TRADER_CSP_SHADOW === '0') return 0;
  _load();
  let resolved = 0;
  for (const [id, row] of [..._open]) {
    const expMs = Date.parse(row.expiration + 'T21:00:00Z');   // ~16:00 ET close of expiry day
    if (!(nowMs >= expMs)) continue;
    let px = null;
    try { px = await getPrice(row.symbol); } catch (_e) { px = null; }
    if (!(px > 0)) continue;                                   // no price → try next scan
    const { outcome, pnl } = resolvePnl(row, px);
    _append({
      event: 'csp_shadow_close', id, ts: new Date(nowMs).toISOString(),
      symbol: row.symbol, strike: row.strike, expiration: row.expiration,
      contracts: row.contracts, premium: row.premium,
      underlying_at_resolve: px, resolve_lag_s: Math.round((nowMs - expMs) / 1000),
      outcome, pnl,
    });
    _open.delete(id); _closedIds.add(id);
    resolved++;
  }
  return resolved;
}

function openCount() { _load(); return _open.size; }
function _resetForTests() { _loaded = false; _open.clear(); _closedIds.clear(); }

module.exports = { onEntry, resolveDue, pickContract, contractsFor, resolvePnl, openCount, FILE, _resetForTests };
