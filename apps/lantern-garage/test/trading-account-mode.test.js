"use strict";
// #2546 — the DEMO / PAPER / TRADE ladder + the per-user house practice account.
//
// These pin the two properties that must never regress silently:
//   1. DEMO IS READ-ONLY. Not by convention, structurally — a caller that forgets to check
//      still cannot place an order, because the demo facade has no working write path.
//   2. PRACTICE ACCOUNTS ARE ISOLATED PER USER. The bug this issue exists to fix was every
//      user without their own keys sharing the operator's Alpaca account.
// Plus the ledger invariants: cash is derived, never stored; no shorting; no spending money
// you don't have.
//
// Run: node apps/lantern-garage/test/trading-account-mode.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acctmode-"));
process.env.ACCOUNT_MODE_DIR = MODE_DIR;

const mode = require("../lib/trading-account-mode");
const house = require("../lib/house-paper-broker");

let failures = 0;
function check(name, fn) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => console.log("  ok  -", name),
    (e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); }); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
  return Promise.resolve();
}

(async () => {
  // ── the ladder ───────────────────────────────────────────────────────────────────────
  await check("a brand-new user defaults to DEMO, not to someone's real account", () => {
    assert.strictEqual(mode.get("brand-new-user"), "demo");
    assert.strictEqual(mode.DEFAULT, "demo");
  });

  await check("an anonymous caller is always demo — no identity, no risk", () => {
    assert.strictEqual(mode.get(null), "demo");
    assert.strictEqual(mode.get(""), "demo");
  });

  await check("DEMO is read-only and refuses orders with a usable next step", () => {
    assert.strictEqual(mode.isReadOnly("demo"), true);
    assert.strictEqual(mode.canPlaceOrders("demo"), false);
    const r = mode.assertCanPlaceOrder("demo");
    assert.ok(r, "demo must produce a rejection");
    assert.strictEqual(r.status, "rejected");
    assert.strictEqual(r.readOnly, true);
    assert.strictEqual(r.nextStep.to, "paper");
  });

  await check("PAPER permits orders; assert returns null (proceed)", () => {
    assert.strictEqual(mode.canPlaceOrders("paper"), true);
    assert.strictEqual(mode.assertCanPlaceOrder("paper"), null);
  });

  await check("an unknown mode falls back to demo — fail closed, never fail open", () => {
    // The dangerous direction is a typo'd/corrupt mode silently permitting orders.
    assert.strictEqual(mode.assertCanPlaceOrder("bogus").status, "rejected");
    assert.strictEqual(mode.assertCanPlaceOrder(undefined).status, "rejected");
  });

  await check("TRADE cannot be set without live credentials", () => {
    assert.strictEqual(mode.set("u1", "trade", { hasLiveCredentials: false }), false);
    assert.strictEqual(mode.get("u1"), "demo", "a refused set must not change the mode");
    assert.strictEqual(mode.set("u1", "trade", { hasLiveCredentials: true }), true);
    assert.strictEqual(mode.get("u1"), "trade");
  });

  await check("describe() names what backs each rung, so the UI states no policy of its own", () => {
    mode.set("u2", "paper");
    const withKeys = mode.describe("u2", { hasPaperKeys: true });
    assert.match(withKeys.backing, /Alpaca paper account \(BYOK\)/);
    const without = mode.describe("u2", { hasPaperKeys: false });
    assert.match(without.backing, /house practice account/);
    assert.strictEqual(without.available.trade, false);
    assert.ok(without.tradeBlockedReason);
  });

  // ── the demo facade is structurally read-only ────────────────────────────────────────
  await check("STRUCTURAL: the demo facade cannot place an order even if the caller forgets to check", async () => {
    mode.set("demo-user", "demo");
    const { brokerFacadeFor } = require("../lib/broker-facade");
    const resolved = await brokerFacadeFor("demo-user", null);
    assert.ok(resolved, "demo must resolve a facade, not null");
    assert.strictEqual(resolved.broker, "demo");
    assert.strictEqual(resolved.readOnly, true);
    // The caller does NOT check the mode — it just places. It must still be refused.
    const r = await resolved.facade.placeIBKROrder("demo-user", { symbol: "SPY", side: "buy", qty: 1 });
    assert.strictEqual(r.status, "rejected");
    assert.strictEqual(r.readOnly, true);
  });

  await check("demo reads the simulated champion book, never the user's account", async () => {
    mode.set("demo-user", "demo");
    const { brokerFacadeFor } = require("../lib/broker-facade");
    const { facade, accountId } = await brokerFacadeFor("demo-user", null);
    assert.strictEqual(accountId, "CHAMPION-DEMO");
    const acct = await facade.getIBKRAccount("demo-user");
    assert.strictEqual(acct.source, "champion-demo");
    assert.strictEqual(acct.demo, true);
    assert.ok((await facade.getIBKRPositions("demo-user")).length > 0, "demo should look populated");
    assert.deepStrictEqual(await facade.getIBKROpenOrders("demo-user"), []);
  });

  // ── the house practice account ───────────────────────────────────────────────────────
  const LEDGER = fs.mkdtempSync(path.join(os.tmpdir(), "paper-"));
  house._setQuoteFn(async (syms) => syms.map((t) => ({ ticker: t, price: t === "SPY" ? 100 : 50 })));

  await check("a brand-new user can place a practice trade owning no brokerage account", async () => {
    const uid = "fresh-" + Date.now();
    const r = await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 10 });
    assert.strictEqual(r.status, "placed");
    assert.strictEqual(r.filled_price, 100);
    assert.strictEqual(r.practice, true);
    const pos = (await house.getPositions(uid)).positions;
    assert.strictEqual(pos.length, 1);
    assert.strictEqual(pos[0].qty, 10);
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("ISOLATION: two users' practice accounts never see each other", async () => {
    const a = "iso-a-" + Date.now(), b = "iso-b-" + Date.now();
    await house.placeOrder(a, { symbol: "SPY", side: "buy", qty: 5 });
    const aPos = (await house.getPositions(a)).positions;
    const bPos = (await house.getPositions(b)).positions;
    assert.strictEqual(aPos.length, 1);
    assert.strictEqual(bPos.length, 0, "user B must not see user A's position");
    assert.notStrictEqual(house._file(a), house._file(b), "separate ledger files");
    const bAcct = await house.getAccount(b);
    assert.strictEqual(bAcct.cash, house.START_EQUITY, "B starts untouched by A's spend");
    [a, b].forEach((u) => fs.rmSync(house._file(u), { force: true }));
  });

  await check("cash is DERIVED from the ledger — buy then sell returns to start plus P&L", async () => {
    const uid = "derive-" + Date.now();
    await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 10 });   // -1000 @100
    house._setQuoteFn(async (s) => s.map((t) => ({ ticker: t, price: 110 })));
    await house.placeOrder(uid, { symbol: "SPY", side: "sell", qty: 10 });  // +1100 @110
    const acct = await house.getAccount(uid);
    assert.strictEqual(acct.cash, house.START_EQUITY + 100, "realized +100");
    assert.strictEqual(acct.realized_today, 100);
    assert.strictEqual((await house.getPositions(uid)).positions.length, 0);
    house._setQuoteFn(async (s) => s.map((t) => ({ ticker: t, price: t === "SPY" ? 100 : 50 })));
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("no shorting, and the refusal says what you actually hold", async () => {
    const uid = "short-" + Date.now();
    const r = await house.placeOrder(uid, { symbol: "SPY", side: "sell", qty: 5 });
    assert.strictEqual(r.status, "rejected");
    assert.match(r.reason, /hold 0 SPY/);
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("cannot spend practice cash you don't have", async () => {
    const uid = "broke-" + Date.now();
    const r = await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 999999 });
    assert.strictEqual(r.status, "rejected");
    assert.match(r.reason, /insufficient practice cash/);
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("a resting limit fills AT THE LIMIT, never at a better observed price", async () => {
    const uid = "limit-" + Date.now();
    const placed = await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 2, limit_price: 90 });
    assert.strictEqual(placed.status, "placed");
    assert.strictEqual((await house.getOpenOrders(uid)).length, 1, "should rest — quote is 100, limit 90");
    house._setQuoteFn(async (s) => s.map((t) => ({ ticker: t, price: 80 })));   // crosses through
    const pos = (await house.getPositions(uid)).positions;
    assert.strictEqual(pos.length, 1);
    assert.strictEqual(pos[0].avg_price, 90, "filled at the limit (90), not the better price (80)");
    assert.strictEqual((await house.getOpenOrders(uid)).length, 0);
    house._setQuoteFn(async (s) => s.map((t) => ({ ticker: t, price: t === "SPY" ? 100 : 50 })));
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("ensureAccount is idempotent — logging in twice never resets your positions", async () => {
    const uid = "idem-" + Date.now();
    await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 3 });
    house.ensureAccount(uid); house.ensureAccount(uid);
    assert.strictEqual((await house.getPositions(uid)).positions[0].qty, 3);
    fs.rmSync(house._file(uid), { force: true });
  });

  await check("a torn trailing ledger line is skipped, not fatal", async () => {
    const uid = "torn-" + Date.now();
    await house.placeOrder(uid, { symbol: "SPY", side: "buy", qty: 1 });
    fs.appendFileSync(house._file(uid), '{"type":"fil');
    assert.strictEqual((await house.getPositions(uid)).positions[0].qty, 1);
    fs.rmSync(house._file(uid), { force: true });
  });

  fs.rmSync(MODE_DIR, { recursive: true, force: true });
  fs.rmSync(LEDGER, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : "\nall trading-account-mode tests passed");
  process.exit(failures ? 1 : 0);
})();
