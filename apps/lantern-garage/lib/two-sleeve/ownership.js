'use strict';
/**
 * lib/two-sleeve/ownership.js — symbol ownership for the two-sleeve engine (#3656).
 *
 * Two brains share ONE broker account. Broker positions carry no owner tag, so the
 * engine keeps a small persisted registry: symbol → sleeve that opened it, and
 * order id → sleeve that placed it. The registry is the whole reason the sleeves
 * never double a position or fight over its exit:
 *
 *   - a BUY on a symbol another sleeve holds is refused (counted as a collision);
 *   - each sleeve's bridge view shows only the positions / orders it owns;
 *   - a symbol whose position has left the book is released on the next reconcile;
 *   - a position nobody claimed (pre-existing, manual, or a lost registry) is
 *     ADOPTED by the default sleeve — the one whose exits are safer (S: intraday,
 *     decarry, weekend-flat) — and journaled, never silently ignored.
 *
 * The file is written synchronously on every change; it is a few hundred bytes.
 * Everything here is pure bookkeeping — no broker calls, no clock of its own.
 */
const fs = require('fs');
const path = require('path');

function createOwnership({ file, defaultOwner = 'S', now = () => Date.now(), onEvent = null } = {}) {
  let state = { symbols: {}, orders: {}, savedAt: 0 };
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object') state = { symbols: j.symbols || {}, orders: j.orders || {}, savedAt: j.savedAt || 0 };
    } catch (_e) { /* first run or unreadable → empty registry */ }
  }
  const emit = (ev) => { if (typeof onEvent === 'function') { try { onEvent(ev); } catch (_e) { /* journaling must never break the engine */ } } };
  const save = () => {
    state.savedAt = now();
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch (_e) { /* fail-soft: memory copy is authoritative until the next save */ }
  };
  const key = (sym) => String(sym || '').toUpperCase();
  const api = {
    /** Sleeve that owns a symbol, or null. */
    ownerOf(sym) { const r = state.symbols[key(sym)]; return r ? r.owner : null; },
    /** Sleeve that placed an order id, or null. */
    orderOwner(orderId) { return state.orders[String(orderId)] || null; },
    /** Register a symbol to a sleeve. Returns false (and changes nothing) if another sleeve holds it. */
    claim(sym, owner) {
      const k = key(sym), cur = state.symbols[k];
      if (cur && cur.owner !== owner) return false;
      if (!cur) { state.symbols[k] = { owner, since: now() }; save(); emit({ event: 'ownership_claim', symbol: k, owner }); }
      return true;
    },
    /**
     * Drop a symbol from the registry (its position left the book). Order tags are KEPT: a
     * filled protective stop must stay attributable to the sleeve that placed it for as long
     * as the broker still reports it — each brain reconciles its own fills from the order
     * list, and a fill that silently moves to the other sleeve reads as an external close
     * (found by the engine validation of 2026-09-18: same entries, different exits). Tags
     * are pruned by pruneOrders() once the broker stops listing the order.
     */
    release(sym, why = 'flat') {
      const k = key(sym), cur = state.symbols[k];
      if (!cur) return;
      delete state.symbols[k];
      save();
      emit({ event: 'ownership_release', symbol: k, owner: cur.owner, why });
    },
    /** Tag an order id with the sleeve that placed it. */
    tagOrder(orderId, sym, owner) { if (orderId == null) return; state.orders[String(orderId)] = { owner, symbol: key(sym) }; save(); },
    /** Forget tags of orders the broker no longer lists (called with the ids it does list). */
    pruneOrders(liveIds) {
      const live = new Set([...(liveIds || [])].map((x) => String(x)));
      let n = 0;
      for (const id of Object.keys(state.orders)) if (!live.has(id)) { delete state.orders[id]; n++; }
      if (n) save();
      return n;
    },
    /**
     * Reconcile the registry with the broker's actual positions: release symbols no longer
     * held, adopt held symbols nobody claimed. Returns { released, adopted }.
     */
    reconcile(positions) {
      const held = new Set((positions || []).filter((p) => Number(p.qty || p.quantity || p.position || 0) !== 0).map((p) => key(p.symbol || p.ticker)));
      const released = [], adopted = [];
      for (const k of Object.keys(state.symbols)) if (!held.has(k)) { released.push(k); api.release(k, 'position left the book'); }
      for (const k of held) if (!state.symbols[k]) { state.symbols[k] = { owner: defaultOwner, since: now(), adopted: true }; adopted.push(k); emit({ event: 'ownership_adopt', symbol: k, owner: defaultOwner }); }
      if (adopted.length) save();
      return { released, adopted };
    },
    /** Read-only copy of the registry. */
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    /** Symbols owned by a sleeve. */
    symbolsOf(owner) { return Object.entries(state.symbols).filter(([, r]) => r.owner === owner).map(([k]) => k); },
  };
  return api;
}

module.exports = { createOwnership };
