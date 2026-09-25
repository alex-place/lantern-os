"use strict";
/**
 * fill-attribution.test.js — a fill belongs to the sleeve that held the position when it filled (live 2026-09-25).
 *
 * 10:00:35 ET: R's TLT stop (placed before the engine, so untagged) filled and R booked it. TLT was released
 * at 10:01, S claimed it at 11:17:57, and S's next read attributed the SAME fill to S by the symbol-owner
 * fallback; S booked a 46-share exit it never held, priced off its own later entry. Three guards:
 *   1. engine bridge: an untagged FILL predating the current owner's claim is nobody's;
 *   2. fill ledger: a fill older than the tracked position's openedAt is not that position's exit;
 *   3. be_ratchet only when the stop FILLED at or above entry (2026-09-03: a -2.87% SOXS stop-out carried
 *      the flag from a stale ratchet entry and fed neither the cooldown nor the breaker).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOwnership } = require("../lib/two-sleeve/ownership");
const { createEngine } = require("../lib/two-sleeve/engine");
const fillLedger = require("../lib/fill-ledger");

const idle = { runAutoTrade: async () => ({}) };
function engineWith(orders, clock) {
  const own = createOwnership({ defaultOwner: "R", now: clock.now });
  const facade = {
    getIBKRAccount: async () => ({ equity: 100000 }),
    getIBKRPositions: async () => [],
    getIBKROpenOrders: async () => orders,
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: "cancelled" }),
    placeIBKROrder: async () => ({ status: "placed", order_id: "x" }),
  };
  const eng = createEngine({ sleeves: [{ id: "S", brain: idle, env: {}, userId: "u" }, { id: "R", brain: idle, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: own, defaultOwner: "R" });
  return { eng, own };
}
const clock = (t0) => { let t = t0; return { now: () => t, set: (v) => { t = v; } }; };

test("an untagged fill that predates the current owner's claim is hidden from that owner (and from the other sleeve)", async () => {
  const c = clock(Date.parse("2026-09-25T13:00:00Z"));
  const fill = { id: "29e09ee7", symbol: "TLT", side: "sell", type: "stop", qty: 46, status: "filled", filled_at: "2026-09-25T14:00:35Z", filled_avg_price: 79.16 };
  const { eng, own } = engineWith([fill], c);
  own.reconcile([{ symbol: "TLT", qty: 46 }]);            // adopted by R at 13:00Z, before the fill
  assert.equal(own.ownerOf("TLT"), "R");
  assert.equal((await eng.bridgeFor("R").getIBKROpenOrders("u")).length, 1, "R, whose claim predates the fill, sees it");
  assert.equal((await eng.bridgeFor("S").getIBKROpenOrders("u")).length, 0);
  // the position leaves the book, S claims the symbol AFTER the fill
  c.set(Date.parse("2026-09-25T14:01:00Z")); own.reconcile([]);
  c.set(Date.parse("2026-09-25T15:17:57Z")); own.claim("TLT", "S");
  assert.equal((await eng.bridgeFor("S").getIBKROpenOrders("u")).length, 0, "S's claim is younger than the fill: not S's");
  assert.equal((await eng.bridgeFor("R").getIBKROpenOrders("u")).length, 0, "and no longer R's either — nobody re-books it");
});

test("an untagged OPEN order still follows the symbol owner (the pre-engine stop of an adopted carry)", async () => {
  const c = clock(Date.parse("2026-09-25T13:00:00Z"));
  const open = { id: "stop1", symbol: "DIA", side: "sell", type: "stop", qty: 7, status: "submitted", created_at: "2026-09-22T16:13:00Z" };
  const { eng, own } = engineWith([open], c);
  own.reconcile([{ symbol: "DIA", qty: 7 }]);
  assert.equal((await eng.bridgeFor("R").getIBKROpenOrders("u")).length, 1);
  assert.equal((await eng.bridgeFor("S").getIBKROpenOrders("u")).length, 0);
});

test("fill ledger: a fill older than the tracked position's openedAt is not booked against it", () => {
  const orders = [{ orderId: "29e09ee7", symbol: "TLT", side: "sell", orderType: "Stop", status: "filled", filledQty: 46, avgPrice: 79.16, filledAt: "2026-09-25T14:00:35Z" }];
  const openedAt = Date.parse("2026-09-25T15:17:50Z");
  const entryFor = () => ({ avg_entry_price: 78.98, openedAt, reason: "broker fill" });
  const rows = fillLedger.newExitRows(orders, new Set(), entryFor, 0);
  assert.equal(rows.length, 0, "a 10:00 fill cannot close an 11:17 position");
  const later = [{ ...orders[0], orderId: "8844abb9", filledAt: "2026-09-25T16:00:15Z", avgPrice: 79.21, filledQty: 25 }];
  const rows2 = fillLedger.newExitRows(later, new Set(), entryFor, 0);
  assert.equal(rows2.length, 1, "a fill after the open is this position's exit");
  assert.equal(rows2[0].qty, 25);
});
