// Dual-source role reconciliation: Patreon and Stripe both feed ONE role, and revoking
// one source must never over-demote the other. Exercises the real profile seams
// (applyStripeState + getOrCreateFromIdentity) end-to-end against a temp profile store.
//
// The load-bearing invariants:
//   • effective role = MAX(patreonRole floor, stripeRole) — a Stripe sub survives a
//     Patreon downgrade, and cancelling Stripe drops only to the Patreon floor;
//   • a Pilot Stripe sub flips the ai_trader entitlement on, and revoke flips it off;
//   • a staff/admin role is never demoted by a paid recompute;
//   • a purchase can never mint admin.
//
// Run: node apps/lantern-garage/test/stripe-dualsource.test.js  (isolates profiles to a temp cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-stripe-"));
process.chdir(_tmpDataRoot);
// The data root is module-anchored, not cwd-derived (#3088) — isolate the store via
// UNISONA_STATE_DIR so this test never writes into the real repo data/ tree.
process.env.UNISONA_STATE_DIR = _tmpDataRoot;
const profiles = require(path.join(__dirname, "..", "lib", "user-profiles"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

let n = 0;
function seed(role, extra = {}) {
  const id = "u" + ++n;
  profiles.createProfile(id, { role, source: "patreon",
    identities: [{ provider: "patreon", providerId: id, email: null, emailVerified: false }], ...extra });
  return id;
}
const get = (id) => profiles.getProfile(id);

// ── grant / revoke basics ────────────────────────────────────────────────────
check("Stripe grant on a free user → role + stripe snapshot; revoke → back to guest floor", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "deep_dreamer", status: "active", customerId: "cus_A", subscriptionId: "sub_A" });
  let p = get(id);
  assert.equal(p.role, "deep_dreamer");
  assert.equal(p.stripeRole, "deep_dreamer");
  assert.equal(p.stripeCustomerId, "cus_A");
  assert.equal(p.patreonRole, "guest", "seeds the Patreon floor from the pre-Stripe role");

  profiles.applyStripeState(id, { stripeRole: null, status: "canceled" });
  p = get(id);
  assert.equal(p.role, "guest", "revoke drops to the Patreon floor");
  assert.equal(p.stripeRole, null);
});

check("Pilot Stripe sub flips ai_trader ON; revoke flips it OFF", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "pilot", status: "active", customerId: "cus_P" });
  assert.equal(get(id).role, "pilot");
  assert.equal(get(id).entitlements.ai_trader, true, "Pilot unlocks the autonomous trader");

  profiles.applyStripeState(id, { stripeRole: null, status: "canceled" });
  assert.equal(get(id).role, "guest");
  assert.equal(get(id).entitlements.ai_trader, false, "revoke removes ai_trader");
});

// ── the reconciliation cases ─────────────────────────────────────────────────
check("dual: Patreon Pro + Stripe Pilot → Pilot; cancel Stripe → keeps Patreon Pro", () => {
  const id = seed("deep_dreamer"); // Patreon $20
  profiles.applyStripeState(id, { stripeRole: "pilot", status: "active", customerId: "cus_D" });
  assert.equal(get(id).role, "pilot", "MAX(deep_dreamer, pilot)");

  profiles.applyStripeState(id, { stripeRole: null, status: "canceled" });
  assert.equal(get(id).role, "deep_dreamer", "Patreon tier is NOT stripped by a Stripe cancel");
});

check("a Stripe sub SURVIVES a Patreon downgrade login (MAX floor holds)", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "pilot", status: "active", customerId: "cus_S" });
  assert.equal(get(id).role, "pilot");
  // Patreon authoritatively re-attests guest (lapsed/never-paid on Patreon):
  const after = profiles.getOrCreateFromIdentity("patreon", { providerId: id, entitlementResolved: true }, "guest").profile;
  assert.equal(after.role, "pilot", "Stripe pilot is not clobbered by a guest Patreon read");
  assert.equal(after.patreonRole, "guest", "records the Patreon floor snapshot");
});

check("Patreon UPGRADE still raises above a lower Stripe sub", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "supporter", status: "active", customerId: "cus_U" });
  const after = profiles.getOrCreateFromIdentity("patreon", { providerId: id, entitlementResolved: true }, "pilot").profile;
  assert.equal(after.role, "pilot", "MAX(patreon pilot, stripe supporter)");
});

// ── invariants ───────────────────────────────────────────────────────────────
check("applyStripeState NEVER demotes a staff/admin role", () => {
  const id = seed("admin");
  profiles.applyStripeState(id, { stripeRole: "supporter", status: "active", customerId: "cus_ADM" });
  assert.equal(get(id).role, "admin", "a $5 Stripe sub can't demote an admin");
  profiles.applyStripeState(id, { stripeRole: null, status: "canceled" });
  assert.equal(get(id).role, "admin", "cancel doesn't demote admin either");
});

check("a staff role is NOT frozen into the patreonRole floor (demotion sticks; no re-mint)", () => {
  const id = seed("admin");
  // Admin touches Stripe while holding the staff role.
  profiles.applyStripeState(id, { stripeRole: "pilot", status: "active", customerId: "cus_STAFF" });
  assert(get(id).role === "admin", "admin preserved live");
  assert(get(id).patreonRole !== "admin", "staff role must NOT be persisted as the floor snapshot: " + get(id).patreonRole);
  // Legitimate demotion.
  profiles.setUserRole(id, "guest");
  assert(get(id).role === "guest", "demotion applied");
  // A later ordinary billing webhook must NOT resurrect admin.
  profiles.applyStripeState(id, { status: "active" });
  assert(get(id).role !== "admin", "webhook re-minted admin (privilege re-escalation): " + get(id).role);
});

check("a bad stripeRole snapshot can never mint admin", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "admin", status: "active", customerId: "cus_EVIL" });
  assert.equal(get(id).role, "guest", "non-whitelisted stripeRole is clamped to guest");
  assert.notEqual(get(id).role, "admin");
});

check("getProfileByStripeCustomer resolves the webhook's customer→profile link", () => {
  const id = seed("guest");
  profiles.applyStripeState(id, { stripeRole: "supporter", status: "active", customerId: "cus_LINK" });
  const found = profiles.getProfileByStripeCustomer("cus_LINK");
  assert.ok(found && found.id === id);
  assert.equal(profiles.getProfileByStripeCustomer("cus_missing"), null);
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
