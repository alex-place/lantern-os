"use strict";
// Tier enforcement ladder: entitlements (pro/trade/ai_trader) by role, and the
// server-side chat daily caps. Patreon amount→role is covered by patreon-tier-amount.test.js;
// this covers what each role UNLOCKS. Run: node test/tier-entitlements.test.js
const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { hasEntitlement } = require("../lib/auth-middleware");
const { roleLevel } = require("../lib/role-hierarchy");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

// A request carrying a signed-in session with the given role.
const reqFor = (role, id = "u1") => ({ session: { user: { id, role } } });

// ── role hierarchy: pilot sits between Pro and admin ──────────────────────────
check("hierarchy: guest < supporter < deep_dreamer < pilot < admin", () => {
  assert.ok(roleLevel("guest") < roleLevel("supporter"));
  assert.ok(roleLevel("supporter") < roleLevel("deep_dreamer"));
  assert.ok(roleLevel("deep_dreamer") < roleLevel("pilot"));
  assert.ok(roleLevel("pilot") < roleLevel("admin"));
});

// ── entitlements by role ──────────────────────────────────────────────────────
check("guest (Free): no pro / trade / ai_trader", () => {
  const r = reqFor("guest");
  assert.strictEqual(hasEntitlement(r, "pro"), false);
  assert.strictEqual(hasEntitlement(r, "trade"), false);
  assert.strictEqual(hasEntitlement(r, "ai_trader"), false);
});
check("supporter ($5 Member): still no Pro-tier entitlements", () => {
  const r = reqFor("supporter");
  assert.strictEqual(hasEntitlement(r, "pro"), false);
  assert.strictEqual(hasEntitlement(r, "trade"), false);
  assert.strictEqual(hasEntitlement(r, "ai_trader"), false);
});
check("deep_dreamer ($20 Pro): pro + trade YES, ai_trader NO", () => {
  const r = reqFor("deep_dreamer");
  assert.strictEqual(hasEntitlement(r, "pro"), true);
  assert.strictEqual(hasEntitlement(r, "trade"), true);
  assert.strictEqual(hasEntitlement(r, "ai_trader"), false); // AI trader is Pilot-only
});
check("pilot ($200 Pilot): pro + trade + ai_trader ALL yes", () => {
  const r = reqFor("pilot");
  assert.strictEqual(hasEntitlement(r, "pro"), true);
  assert.strictEqual(hasEntitlement(r, "trade"), true);
  assert.strictEqual(hasEntitlement(r, "ai_trader"), true);
});
check("admin: holds every entitlement implicitly", () => {
  const r = reqFor("admin");
  assert.strictEqual(hasEntitlement(r, "pro"), true);
  assert.strictEqual(hasEntitlement(r, "ai_trader"), true);
  assert.strictEqual(hasEntitlement(r, "anything_at_all"), true);
});
check("anonymous (no session): no entitlements", () => {
  assert.strictEqual(hasEntitlement({}, "pro"), false);
  assert.strictEqual(hasEntitlement({}, "trade"), false);
});

// ── chat daily caps by tier (env-overridable defaults) ────────────────────────
// Point the quota store at a temp file via the module's own path? It writes to a fixed
// data dir; we only assert capFor() (pure, no disk) for the cap numbers, and consume()
// against a throwaway HOME-independent path isn't needed — capFor is the tier logic.
const quota = require("../lib/chat-quota");
check("caps: anon 10 / Free 50 / Member 100 / Pro 250 / Pilot ∞", () => {
  assert.strictEqual(quota.capFor({}).cap, 10);                               // anonymous
  assert.strictEqual(quota.capFor(reqFor("guest")).cap, 50);                  // signed-in Free
  assert.strictEqual(quota.capFor(reqFor("supporter")).cap, 100);            // $5 Member
  assert.strictEqual(quota.capFor(reqFor("deep_dreamer")).cap, 250);         // $20 Pro
  assert.strictEqual(quota.capFor(reqFor("pilot")).cap, Infinity);           // $200 Pilot
  assert.strictEqual(quota.capFor(reqFor("admin")).cap, Infinity);           // staff
});
check("consume: enforces the cap then blocks (isolated temp store)", () => {
  // Exercise the real read/increment/deny cycle in a temp CWD-independent way by
  // driving a low cap through capFor's Free tier is fixed at 50; instead validate the
  // block logic directly: consume N times for a role and confirm allowed flips to false.
  // Use anon (cap 10) and a unique IP so the shared store key won't collide across runs.
  const uniqueIp = "10.9." + (process.pid % 250) + "." + (Date.now() % 250);
  const r = { headers: { "x-forwarded-for": uniqueIp }, socket: {} };
  let lastAllowed = true, count = 0;
  for (let i = 0; i < 12; i++) { const q = quota.consume(r); if (q.allowed) count++; else { lastAllowed = false; break; } }
  assert.strictEqual(lastAllowed, false, "must eventually block");
  assert.strictEqual(count, 10, "anon cap is 10 allowed before the block");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll tier-entitlements tests passed.");
