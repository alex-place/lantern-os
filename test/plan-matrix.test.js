"use strict";
// Tests for lib/plan-matrix.js (#2550) — the four-plan capability matrix.
// Framework-free. Proves per-tier enforcement + internal consistency; the matrix
// is pure, so these run with no server. (The live gate stays OFF by default; this
// verifies the MECHANISM the founder flips on at Level 2.)

const assert = require("assert");
const pm = require("../lib/plan-matrix");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); }
  catch (e) { failures++; console.error(`  FAIL- ${name}\n      ${e.message}`); }
}

check("role → plan mapping (supporter grandfathered to Free)", () => {
  assert.strictEqual(pm.planForRole("guest"), "free");
  assert.strictEqual(pm.planForRole("supporter"), "free");
  assert.strictEqual(pm.planForRole("deep_dreamer"), "pro");
  assert.strictEqual(pm.planForRole("founder"), "pro");
  assert.strictEqual(pm.planForRole("admin"), "pilot");
  assert.strictEqual(pm.planForRole("nonsense"), "free", "unknown → free floor");
});

check("Free tier: gets Free caps, denied Pro + Pilot caps", () => {
  assert.strictEqual(pm.roleHasCapability("guest", "chat_memory"), true);
  assert.strictEqual(pm.roleHasCapability("guest", "paper_account"), true);
  assert.strictEqual(pm.roleHasCapability("guest", "demo_view"), true);
  assert.strictEqual(pm.roleHasCapability("guest", "live_trading"), false);
  assert.strictEqual(pm.roleHasCapability("guest", "byok_keys"), false);
  assert.strictEqual(pm.roleHasCapability("supporter", "live_trading"), false, "$5 supporter is Free, no real-money trading");
  assert.strictEqual(pm.roleHasCapability("guest", "ai_trader"), false);
});

check("Pro tier ($20 deep_dreamer): Free + Pro caps, denied Pilot caps", () => {
  for (const c of ["chat_memory", "live_trading", "byok_keys", "price_alerts", "creator_suite", "wide_research"]) {
    assert.strictEqual(pm.roleHasCapability("deep_dreamer", c), true, `Pro must have ${c}`);
  }
  assert.strictEqual(pm.roleHasCapability("deep_dreamer", "ai_trader"), false, "autonomous trader is Pilot-only");
  assert.strictEqual(pm.roleHasCapability("deep_dreamer", "unisona_trader"), false);
  assert.strictEqual(pm.roleHasCapability("deep_dreamer", "roadmap_say"), false);
});

check("Pilot tier ($200): everything", () => {
  for (const c of Object.keys(pm.CAPABILITIES)) {
    assert.strictEqual(pm.roleHasCapability("admin", c), true, `Pilot must have ${c}`);
  }
  assert.strictEqual(pm.roleHasCapability("admin", "ai_trader"), true);
  assert.strictEqual(pm.roleHasCapability("admin", "unisona_trader"), true);
});

check("monotonic ladder: every Free cap ⊆ Pro caps ⊆ Pilot caps", () => {
  const free = new Set(pm.capabilitiesForPlan("free"));
  const pro = new Set(pm.capabilitiesForPlan("pro"));
  const pilot = new Set(pm.capabilitiesForPlan("pilot"));
  for (const c of free) assert.ok(pro.has(c), `Pro missing Free cap ${c}`);
  for (const c of pro) assert.ok(pilot.has(c), `Pilot missing Pro cap ${c}`);
  assert.ok(pro.size > free.size && pilot.size > pro.size, "each tier strictly adds");
});

check("business is an alias for pilot", () => {
  assert.strictEqual(pm.planRank("business"), pm.planRank("pilot"));
  assert.strictEqual(pm.planHasCapability("business", "ai_trader"), true);
});

check("unknown capability is never granted, to anyone", () => {
  assert.strictEqual(pm.minPlanForCapability("teleportation"), null);
  assert.strictEqual(pm.roleHasCapability("admin", "teleportation"), false);
});

check("legacy entitlement reconciliation: trade→Pro, ai_trader→Pilot", () => {
  // The flagged gate maps a legacy entitlement key to its capability. Assert the
  // mapping the gate relies on stays consistent with the legacy role checks.
  const byEnt = (k) => Object.keys(pm.CAPABILITIES).find((c) => pm.CAPABILITIES[c].entitlement === k);
  assert.strictEqual(pm.minPlanForCapability(byEnt("trade")), "pro");
  assert.strictEqual(pm.minPlanForCapability(byEnt("ai_trader")), "pilot");
});

check("planReport is complete and label-carrying (pricing 1:1 payload)", () => {
  const r = pm.planReport();
  assert.deepStrictEqual(r.plans, ["free", "pro", "pilot"]);
  assert.ok(r.report.pro.some((x) => x.key === "live_trading" && x.label));
  assert.ok(r.report.pilot.some((x) => x.key === "ai_trader"));
});

if (failures) { console.error(`\n${failures} plan-matrix test(s) failed`); process.exit(1); }
console.log("\nAll plan-matrix tests passed.");
