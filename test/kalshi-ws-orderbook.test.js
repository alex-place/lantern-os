"use strict";
// P2-1: unit tests for the pure WS order-book maintainer (snapshot + delta + gap detection).
// Fully offline — synthetic frames. Run: node test/kalshi-ws-orderbook.test.js
const assert = require("assert");
const { OrderBook, consume } = require("../lib/kalshi-ws-orderbook");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

// ── snapshot → BBO derivation ─────────────────────────────────────────────────
check("snapshot derives YES ask from best NO bid (100 − noBid)", () => {
  const ob = new OrderBook("T");
  // YES bids at 40/41 (best 41); NO bids at 55/58 (best 58) → YES ask = 100−58 = 42.
  ob.applySnapshot({ yes: [[40, 10], [41, 5]], no: [[55, 8], [58, 3]], seq: 100 });
  const b = ob.bbo();
  assert.strictEqual(b.yesBid, 41);
  assert.strictEqual(b.yesAsk, 42);
  assert.strictEqual(b.noBid, 58);
  assert.strictEqual(b.noAsk, 59); // 100 − yesBid(41)
  assert.strictEqual(b.spreadCents, 1);
  assert.strictEqual(b.midCents, 41.5);
  assert.strictEqual(b.stale, false);
});

check("empty side → null touch (never fabricated)", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 10]], no: [], seq: 1 });
  const b = ob.bbo();
  assert.strictEqual(b.yesBid, 40);
  assert.strictEqual(b.yesAsk, null);   // no NO bids → no derivable YES ask
  assert.strictEqual(b.spreadCents, null);
});

// ── deltas: add / modify / remove ─────────────────────────────────────────────
check("delta adds a new level and moves the touch", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 10]], no: [[58, 3]], seq: 5 });
  const r = ob.applyDelta({ price: 43, side: "yes", delta: 7, seq: 6 });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(ob.bbo().yesBid, 43);   // new best YES bid
});

check("delta with size going to 0 removes the level", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 10], [43, 7]], no: [[58, 3]], seq: 5 });
  ob.applyDelta({ price: 43, side: "yes", delta: -7, seq: 6 }); // 7 → 0
  assert.strictEqual(ob.bbo().yesBid, 40);   // 43 level gone, best falls to 40
});

check("negative resulting size also removes the level (never goes negative)", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 3]], no: [[58, 3]], seq: 5 });
  ob.applyDelta({ price: 40, side: "yes", delta: -10, seq: 6 });
  assert.strictEqual(ob.bbo().yesBid, null);
});

// ── sequence-gap detection ────────────────────────────────────────────────────
check("in-order deltas keep the book fresh (not stale)", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 1]], no: [[58, 1]], seq: 10 });
  ob.applyDelta({ price: 41, side: "yes", delta: 2, seq: 11 });
  ob.applyDelta({ price: 42, side: "yes", delta: 2, seq: 12 });
  assert.strictEqual(ob.needsResnapshot, false);
  assert.strictEqual(ob.bbo().stale, false);
});

check("a SEQ GAP flags needsResnapshot and does NOT apply the delta", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 1]], no: [[58, 1]], seq: 10 });
  const r = ob.applyDelta({ price: 99, side: "yes", delta: 5, seq: 13 }); // expected 11
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.gap, true);
  assert.strictEqual(ob.needsResnapshot, true);
  assert.strictEqual(ob.bbo().stale, true);
  assert.strictEqual(ob.bbo().yesBid, 40, "gapped delta must not corrupt the book");
});

check("delta before any snapshot is rejected as a gap", () => {
  const ob = new OrderBook("T");
  const r = ob.applyDelta({ price: 40, side: "yes", delta: 1, seq: 1 });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(ob.needsResnapshot, true);
});

check("a fresh snapshot clears the gap flag", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 1]], no: [[58, 1]], seq: 10 });
  ob.applyDelta({ price: 99, side: "yes", delta: 5, seq: 13 }); // gap
  assert.strictEqual(ob.needsResnapshot, true);
  ob.applySnapshot({ yes: [[41, 2]], no: [[57, 2]], seq: 20 });
  assert.strictEqual(ob.needsResnapshot, false);
  assert.strictEqual(ob.bbo().stale, false);
  assert.strictEqual(ob.bbo().yesBid, 41);
});

// ── depth + consume helper ────────────────────────────────────────────────────
check("depth sums resting contracts on a side", () => {
  const ob = new OrderBook("T");
  ob.applySnapshot({ yes: [[40, 10], [41, 5]], no: [[58, 3]], seq: 1 });
  assert.strictEqual(ob.depth("yes"), 15);
  assert.strictEqual(ob.depth("no"), 3);
});

check("consume folds a frame stream into a final book", () => {
  const { book, events } = consume("T", [
    { type: "snapshot", yes: [[40, 1]], no: [[58, 1]], seq: 1 },
    { type: "delta", price: 45, side: "yes", delta: 3, seq: 2 },
  ]);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(book.bbo().yesBid, 45);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-ws-orderbook tests passed.");
