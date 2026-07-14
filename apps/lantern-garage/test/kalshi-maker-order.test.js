"use strict";
// P2-2: unit tests for maker order construction + maker/taker decision. Fully offline.
// Run: node apps/lantern-garage/test/kalshi-maker-order.test.js
const assert = require("assert");
const mo = require("../lib/kalshi-maker-order");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

// ── maker fee is strictly cheaper than taker at the same price ─────────────────
check("maker fee < taker fee at 50¢ (peak of the parabola)", () => {
  assert.ok(mo.feeCents(50, 100, { role: "maker" }) < mo.feeCents(50, 100, { role: "taker" }));
});
check("fee parabola is ~symmetric (35¢ ≈ 65¢) for both roles", () => {
  assert.strictEqual(mo.feeCents(35, 100, { role: "taker" }), mo.feeCents(65, 100, { role: "taker" }));
});

// ── maker limit price: must rest, never cross ─────────────────────────────────
const book = { yes_bid: 48, yes_ask: 52 }; // 4¢ spread

check("maker BUY joins the bid (48), strictly below the ask", () => {
  assert.strictEqual(mo.makerLimitCents(book, "yes", "buy"), 48);
});
check("maker BUY with improveTicks steps up the bid but stays below the ask", () => {
  assert.strictEqual(mo.makerLimitCents(book, "yes", "buy", { improveTicks: 2 }), 50);
  // improving by 10 must still clamp to ask−1 = 51, never cross
  assert.strictEqual(mo.makerLimitCents(book, "yes", "buy", { improveTicks: 10 }), 51);
});
check("maker SELL joins the ask (52), strictly above the bid", () => {
  assert.strictEqual(mo.makerLimitCents(book, "yes", "sell"), 52);
});
check("maker limit is null when the needed side is missing (no fabrication)", () => {
  assert.strictEqual(mo.makerLimitCents({ yes_ask: 52 }, "yes", "buy"), null); // no bid
});

// ── maker/taker decision ──────────────────────────────────────────────────────
check("wide spread + not urgent → MAKER, resting below the ask", () => {
  const d = mo.decideExecution(book, { side: "yes", contracts: 10 });
  assert.strictEqual(d.mode, "maker");
  assert.strictEqual(d.limitCents, 48);
  assert.ok(d.savingCents > 0, "maker must save cents vs taking");
});
check("urgent → TAKER regardless of spread", () => {
  const d = mo.decideExecution(book, { side: "yes", urgent: true });
  assert.strictEqual(d.mode, "taker");
  assert.match(d.reason, /urgent/);
});
check("tight spread (1¢) → TAKER, nothing to capture", () => {
  const tight = { yes_bid: 50, yes_ask: 51 };
  const d = mo.decideExecution(tight, { side: "yes", minSpreadCents: 2 });
  assert.strictEqual(d.mode, "taker");
});
check("no ask in book → TAKER path reports it can't price", () => {
  const d = mo.decideExecution({ yes_bid: 40 }, { side: "yes" });
  assert.strictEqual(d.mode, "taker");
  assert.strictEqual(d.limitCents, null);
});
check("maker saving grows with contract count", () => {
  const one = mo.decideExecution(book, { side: "yes", contracts: 1 }).savingCents;
  const ten = mo.decideExecution(book, { side: "yes", contracts: 10 }).savingCents;
  assert.ok(ten > one);
});
check("a richer maker rate (lower multiplier) increases the saving", () => {
  const base = mo.decideExecution(book, { side: "yes", contracts: 50, makerMultiplier: 0.05 }).savingCents;
  const rich = mo.decideExecution(book, { side: "yes", contracts: 50, makerMultiplier: 0.01 }).savingCents;
  assert.ok(rich >= base);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-maker-order tests passed.");
