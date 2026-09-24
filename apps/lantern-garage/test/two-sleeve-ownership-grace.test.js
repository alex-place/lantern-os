"use strict";
/**
 * two-sleeve-ownership-grace.test.js — a fresh claim survives a lagging positions read (live, 2026-09-23).
 *
 * At 13:15:54 the S sleeve bought UPRO and the engine claimed it for S. 242 ms later S's own positions
 * read, taken before the broker had registered the fill, reconciled UPRO away as "position left the
 * book"; the next tick adopted the orphan to R, which re-protected S's position with its own 2% stop.
 * The rule now: a claim that has never been SEEN held survives absences for a grace period; once seen,
 * an absence is a real close and releases immediately, exactly as before.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOwnership } = require("../lib/two-sleeve/ownership");

function clock(start) { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; }

test("a fresh claim is NOT released by a positions read that does not show the fill yet", () => {
  const c = clock(1_000_000);
  const events = [];
  const own = createOwnership({ defaultOwner: "R", now: c.now, onEvent: (e) => events.push(e) });
  assert.equal(own.claim("UPRO", "S"), true);
  c.tick(242);
  const r1 = own.reconcile([{ symbol: "SPY", qty: 4 }]);           // the broker's list lags the fill
  assert.deepEqual(r1, { released: [], adopted: ["SPY"] });
  assert.equal(own.ownerOf("UPRO"), "S", "the claim survives the lag");
  c.tick(68_000);
  const r2 = own.reconcile([{ symbol: "SPY", qty: 4 }, { symbol: "UPRO", qty: 6 }]);   // now visible
  assert.deepEqual(r2, { released: [], adopted: [] });
  assert.equal(own.ownerOf("UPRO"), "S", "never adopted by the default owner");
  assert.ok(!events.some((e) => e.event === "ownership_release" && e.symbol === "UPRO"));
});

test("once a claimed symbol has been seen held, an absence releases it immediately (a real close)", () => {
  const c = clock(1_000_000);
  const own = createOwnership({ defaultOwner: "R", now: c.now });
  own.claim("SOXL", "S");
  own.reconcile([{ symbol: "SOXL", qty: 10 }]);                    // seen
  c.tick(1_000);
  const r = own.reconcile([]);                                     // the stop filled, the book is empty
  assert.deepEqual(r, { released: ["SOXL"], adopted: [] });
  assert.equal(own.ownerOf("SOXL"), null);
});

test("a claim that is never seen held is released once the grace period has passed", () => {
  const c = clock(1_000_000);
  const own = createOwnership({ defaultOwner: "R", now: c.now });
  own.claim("TNA", "S");                                           // a buy the broker rejected after all
  c.tick(5 * 60 * 1000 + 1);
  const r = own.reconcile([]);
  assert.deepEqual(r, { released: ["TNA"], adopted: [] });
});

test("adopted symbols are marked seen, so their first absence releases them as before", () => {
  const c = clock(1_000_000);
  const own = createOwnership({ defaultOwner: "R", now: c.now });
  own.reconcile([{ symbol: "DIA", qty: 7 }]);
  assert.equal(own.ownerOf("DIA"), "R");
  c.tick(1_000);
  assert.deepEqual(own.reconcile([]), { released: ["DIA"], adopted: [] });
});
