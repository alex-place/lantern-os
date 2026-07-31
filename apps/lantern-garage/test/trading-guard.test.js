"use strict";
/**
 * trading-guard.test.js — the safety gate in front of every real broker order.
 * These tests exist because the failure mode is real money. Run:
 *   node --test test/trading-guard.test.js
 */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { orderGate } = require("../lib/trading-guard");

// Snapshot + restore the env keys the gate reads, so tests don't leak into each other.
const KEYS = ["TRADER_LIVE", "TRADER_ALLOW_LIVE_ACCOUNT", "MAX_ORDER_QTY", "MAX_ORDER_NOTIONAL"];
let saved;
beforeEach(() => { saved = {}; for (const k of KEYS) saved[k] = process.env[k]; for (const k of KEYS) delete process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test("default posture is DRY (TRADER_LIVE unset)", () => {
  const g = orderGate({ mode: "paper", qty: 1, price: 100 });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.dry, true);
  assert.match(g.reason, /TRADER_LIVE=0/);
});

test("armed on a paper account is allowed", () => {
  process.env.TRADER_LIVE = "1";
  const g = orderGate({ mode: "paper", qty: 1, price: 100 });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.dry, false);
});

test("live (real-money) account needs the second opt-in", () => {
  process.env.TRADER_LIVE = "1";
  let g = orderGate({ mode: "live", qty: 1, price: 100 });
  assert.strictEqual(g.allowed, false, "live account must be blocked without TRADER_ALLOW_LIVE_ACCOUNT");
  assert.match(g.reason, /real-money/i);
  process.env.TRADER_ALLOW_LIVE_ACCOUNT = "1";
  g = orderGate({ mode: "live", qty: 1, price: 100 });
  assert.strictEqual(g.allowed, true, "live account allowed once explicitly opted in");
});

test("unknown account mode is refused even when armed", () => {
  process.env.TRADER_LIVE = "1";
  const g = orderGate({ mode: "unknown", qty: 1, price: 100 });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /unknown/i);
});

// MAX_ORDER_QTY is a share-count SANITY ceiling (default 100000), not the real
// limit — notional governs, and a fractional-share book legitimately places
// four-figure share counts on cheap names. So: a big-but-sane qty under the
// notional cap must PASS, and only an absurd one trips the ceiling.
test("qty cap is a sanity ceiling, not the real limit", () => {
  process.env.TRADER_LIVE = "1";
  const ok = orderGate({ mode: "paper", qty: 101, price: 1 });   // $101 notional
  assert.strictEqual(ok.allowed, true, "a sane share count under the notional cap must not be blocked by qty");

  process.env.MAX_ORDER_QTY = "100";
  const capped = orderGate({ mode: "paper", qty: 101, price: 1 });
  assert.strictEqual(capped.allowed, false);
  assert.match(capped.reason, /MAX_ORDER_QTY/);
});

test("notional cap blocks expensive orders", () => {
  process.env.TRADER_LIVE = "1";
  const g = orderGate({ mode: "paper", qty: 50, price: 100 }); // $5000 > $2000
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /MAX_ORDER_NOTIONAL/);
});

test("zero / missing qty is rejected", () => {
  process.env.TRADER_LIVE = "1";
  assert.strictEqual(orderGate({ mode: "paper", qty: 0, price: 100 }).allowed, false);
  assert.strictEqual(orderGate({ mode: "paper", price: 100 }).allowed, false);
});

test("caps are configurable via env", () => {
  process.env.TRADER_LIVE = "1";
  process.env.MAX_ORDER_QTY = "5";
  const g = orderGate({ mode: "paper", qty: 10, price: 1 });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.caps.maxQty, 5);
});
