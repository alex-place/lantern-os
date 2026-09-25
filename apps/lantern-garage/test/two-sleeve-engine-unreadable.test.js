"use strict";
/**
 * two-sleeve-engine-unreadable.test.js — a broker outage must not read as a flat book (live 2026-09-25).
 *
 * 04:04-04:06 ET: Alpaca was unavailable for three ticks. Both brains stood down with
 * "account/equity unavailable", but the engine's own reconcile ran on the adapter's failure shape
 * ({ positions: [] }) and RELEASED all four R carries ("position left the book"); when the API came
 * back they were ADOPTED to the default owner. All four were R's, so nothing broke — an S carry would
 * have been orphaned to R and re-protected with R's stop, the UPRO defect of 09-23 by another door.
 *
 * Rules under test: a read the facade marks unreadable, a null read, or a read taken while the
 * account is unreadable never reconciles; a genuinely empty read with a healthy account still does.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOwnership } = require("../lib/two-sleeve/ownership");
const { createEngine } = require("../lib/two-sleeve/engine");

const idleBrain = { runAutoTrade: async (scan, { bridge, userId }) => ({ positions: await bridge.getIBKRPositions(userId) }) };
function engineWith(facade, rows, seed) {
  const ownership = createOwnership({ defaultOwner: "R" });
  for (const [sym, owner] of Object.entries(seed || {})) { ownership.claim(sym, owner); }
  ownership.reconcile(Object.keys(seed || {}).map((symbol) => ({ symbol, qty: 1 })));   // mark them SEEN, as live claims are
  const eng = createEngine({ sleeves: [{ id: "S", brain: idleBrain, env: {}, userId: "u" }, { id: "R", brain: idleBrain, env: {}, userId: "u" }],
    order: ["S", "R"], facade, ownership, defaultOwner: "R", journal: (r) => rows.push(r) });
  return { eng, ownership };
}
const baseFacade = (over) => ({
  getIBKRAccount: async () => ({ equity: 100000 }),
  getIBKRPositions: async () => [],
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => 0,
  cancelIBKROrder: async () => ({ status: "cancelled" }),
  placeIBKROrder: async () => ({ status: "placed", order_id: "x" }),
  ...over,
});

test("the adapter's failure shape ({positions: [], unreadable: true}) releases nothing", async () => {
  const rows = [];
  const { eng, ownership } = engineWith(baseFacade({ getIBKRPositions: async () => ({ positions: [], unreadable: true, status: 503 }) }), rows, { TLT: "S", DIA: "R" });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(ownership.ownerOf("TLT"), "S");
  assert.equal(ownership.ownerOf("DIA"), "R");
  assert.ok(rows.some((r) => r.event === "reconcile_skipped" && /unreadable/.test(r.why)), "the skip is journaled");
  assert.ok(!rows.some((r) => /^ownership_release/.test(r.event)), "no release rows");
});

test("a null positions read releases nothing", async () => {
  const rows = [];
  const { eng, ownership } = engineWith(baseFacade({ getIBKRPositions: async () => null }), rows, { TLT: "S" });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(ownership.ownerOf("TLT"), "S");
  assert.ok(rows.some((r) => r.event === "reconcile_skipped"));
});

test("an empty read while the ACCOUNT is unreadable releases nothing (the 04:04 shape)", async () => {
  const rows = [];
  const { eng, ownership } = engineWith(baseFacade({ getIBKRAccount: async () => null, getIBKRPositions: async () => [] }), rows, { TLT: "S", DIA: "R" });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(ownership.ownerOf("TLT"), "S");
  assert.equal(ownership.ownerOf("DIA"), "R");
  assert.ok(rows.some((r) => r.event === "reconcile_skipped" && /account/.test(r.why)));
});

test("a genuinely empty book with a healthy account still releases (the flat-book path is intact)", async () => {
  const rows = [];
  const { eng, ownership } = engineWith(baseFacade({ getIBKRPositions: async () => [] }), rows, { TLT: "S" });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(ownership.ownerOf("TLT"), null, "seen-then-absent with a healthy account is a real close");
  assert.ok(rows.some((r) => r.event === "ownership_released"));
});

test("the per-sleeve bridge view of an unreadable read is an empty list and reconciles nothing", async () => {
  const rows = [];
  const { eng, ownership } = engineWith(baseFacade({ getIBKRPositions: async () => ({ positions: [], unreadable: true }) }), rows, { TLT: "S" });
  const view = await eng.bridgeFor("S").getIBKRPositions("u");
  assert.deepEqual(view, []);
  assert.equal(ownership.ownerOf("TLT"), "S");
});
