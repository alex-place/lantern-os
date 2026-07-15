"use strict";
// P1-4: unit tests for the swappable fill/slippage model + reconciliation.
// Run: node apps/lantern-garage/test/kalshi-fill-model.test.js
const assert = require("assert");
const fm = require("../lib/kalshi-fill-model");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

// A book with a 2¢ spread on the YES side: bid 48, ask 50 (mid 49).
const book = { yes_bid: 48, yes_ask: 50, no_bid: 50, no_ask: 52 };

check("topOfBook: BUY yes fills at the ask (50)", () =>
  assert.strictEqual(fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "topOfBook" }), 50));
check("topOfBook: SELL yes fills at the bid (48)", () =>
  assert.strictEqual(fm.expectedFillCents({ side: "yes", action: "sell" }, book, { model: "topOfBook" }), 48));
check("mid: fills at the spread midpoint (49)", () =>
  assert.strictEqual(fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "mid" }), 49));

check("slippage: BUY fills WORSE than the ask (higher)", () => {
  const px = fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "slippage", slippageCents: 2 });
  assert.strictEqual(px, 52); // 50 + 2 adverse
});
check("slippage: SELL fills WORSE than the bid (lower)", () => {
  const px = fm.expectedFillCents({ side: "yes", action: "sell" }, book, { model: "slippage", slippageCents: 2 });
  assert.strictEqual(px, 46); // 48 - 2 adverse
});

check("mid is between the topOfBook buy and sell fills", () => {
  const buy = fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "topOfBook" });
  const sell = fm.expectedFillCents({ side: "yes", action: "sell" }, book, { model: "topOfBook" });
  const mid = fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "mid" });
  assert.ok(sell <= mid && mid <= buy, `expected ${sell} <= ${mid} <= ${buy}`);
});

check("missing side in book → null (never fabricates a fill)", () =>
  assert.strictEqual(fm.expectedFillCents({ side: "yes", action: "buy" }, { no_bid: 1 }, { model: "mid" }), null));

check("dollar-denominated book fields are honored", () => {
  const dbook = { yes_ask_dollars: 0.50, yes_bid_dollars: 0.48 };
  assert.strictEqual(fm.expectedFillCents({ side: "yes", action: "buy" }, dbook, { model: "topOfBook" }), 50);
});

check("unknown model throws", () =>
  assert.throws(() => fm.expectedFillCents({ side: "yes", action: "buy" }, book, { model: "nope" })));

// ── reconciliation (no disk write: log:false) ──
check("reconcile: BUY filled above expected → positive (adverse) slippage", () => {
  const r = fm.reconcile({ ticker: "T", action: "buy", expectedCents: 50, actualCents: 52, log: false });
  assert.strictEqual(r.slippageCents, 2);
});
check("reconcile: SELL filled below expected → positive (adverse) slippage", () => {
  const r = fm.reconcile({ ticker: "T", action: "sell", expectedCents: 48, actualCents: 46, log: false });
  assert.strictEqual(r.slippageCents, 2);
});
check("reconcile: BUY filled better (lower) → negative slippage", () => {
  const r = fm.reconcile({ ticker: "T", action: "buy", expectedCents: 50, actualCents: 49, log: false });
  assert.strictEqual(r.slippageCents, -1);
});
check("reconcile: missing actual → null slippage, not a guess", () => {
  const r = fm.reconcile({ ticker: "T", action: "buy", expectedCents: 50, actualCents: null, log: false });
  assert.strictEqual(r.slippageCents, null);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-fill-model tests passed.");
