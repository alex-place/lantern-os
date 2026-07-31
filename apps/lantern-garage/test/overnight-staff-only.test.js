"use strict";
/**
 * overnight-staff-only.test.js — the overnight book is NOT a customer feature.
 *
 * Operator decision 2026-07-31: the overnight sleeve book is too early in development
 * to hand to users. What the $200 Pilot tier buys is the INTRADAY and CHAMPION traders.
 *
 * This matters more than a normal feature gate because the overnight book is not
 * per-user at all: lib/overnight-trader.js runs as ONE identity (OVERNIGHT_USER,
 * default local-owner). Both routes were previously ungated, so ANY signed-in user
 * could POST /run to force a tick of the OPERATOR'S OWN broker account, and GET leaked
 * its account id, open legs and edge statistics.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const overnightRoutes = require("../routes/trading/overnight");

function fakeRes() {
  return {
    statusCode: null, headers: null, body: "", ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(b) { this.body = b || ""; this.ended = true; },
  };
}
function ctxFor(res) {
  return {
    sendJson: (r, obj, code) => { r.statusCode = code; r.body = JSON.stringify(obj); r.ended = true; },
    bridge: {},
  };
}

test("a guest cannot read the operator's overnight book", async () => {
  const res = fakeRes();
  const handled = await overnightRoutes(
    { method: "GET", url: "/api/trading/overnight", headers: {} },
    res, new URL("http://x/api/trading/overnight"), ctxFor(res),
  );
  assert.strictEqual(handled, true, "the route must claim the request, not fall through");
  assert.ok(res.statusCode === 403 || res.statusCode === 302,
    `expected a gate (403/302), got ${res.statusCode}`);
  assert.ok(!/accountId|sleeves|edge/i.test(res.body || ""), "must not leak book state to a guest");
});

test("a guest cannot FORCE A TICK of the operator's account", async () => {
  let ticked = false;
  const overnight = require("../lib/overnight-trader");
  const realTick = overnight.tick;
  overnight.tick = async () => { ticked = true; return {}; };
  try {
    const res = fakeRes();
    await overnightRoutes(
      { method: "POST", url: "/api/trading/overnight/run", headers: {} },
      res, new URL("http://x/api/trading/overnight/run"), ctxFor(res),
    );
    assert.strictEqual(ticked, false, "an ungated /run trades the operator's own account");
    assert.ok(res.statusCode === 403 || res.statusCode === 302);
  } finally {
    overnight.tick = realTick;
  }
});

test("the paid tiers buy the intraday + champion traders, not this", () => {
  // Guard the entitlement model itself: ai_trader is the Pilot capability the scan
  // loop checks per-user. There is deliberately NO overnight capability to sell.
  const pm = require("../lib/plan-matrix");
  assert.strictEqual(pm.minPlanForCapability("ai_trader"), "pilot");
  assert.strictEqual(pm.planHasCapability("pilot", "ai_trader"), true);
  assert.strictEqual(pm.planHasCapability("pro", "ai_trader"), false, "$20 Pro must not get the autopilot");
  assert.strictEqual(pm.planHasCapability("free", "ai_trader"), false);
  for (const cap of Object.keys(pm.CAPABILITIES)) {
    assert.ok(!/overnight/i.test(cap), `overnight must not be a sellable capability (found ${cap})`);
  }
});
