// Patreon tier → role is gated by PLEDGE AMOUNT, not campaign-specific tier IDs, so a
// move to a new Patreon campaign (patreon.com/cw/UnisonaAI) doesn't silently break
// role gating. $5→supporter (Member), $20→deep_dreamer (Pro, trading unlock), $200→pilot
// (Pilot, autonomous AI trader). A PURCHASABLE tier can NEVER grant the operator `admin`
// role — `pilot` is the top buyable tier; admin comes only from LANTERN_ADMIN_IDS.
//
// Run: node apps/lantern-garage/test/patreon-tier-amount.test.js
const assert = require("assert");
const { PROVIDERS, roleForAmountCents, isAdminOverride, resolveRole } = require("../lib/auth-providers");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// mapRole gates on amounts; a bare membership (tier id, no paid amount) must NOT grant a paid role.
const mapRole = (amountsCents, tierIds = ["t"]) =>
  PROVIDERS.patreon.mapRole({ entitledAmountsCents: amountsCents, memberships: tierIds });

check("no membership → guest", () => assert.equal(mapRole([], []), "guest"));
check("$5 → supporter", () => assert.equal(mapRole([500]), "supporter"));
check("$20 → deep_dreamer (trading unlock)", () => assert.equal(mapRole([2000]), "deep_dreamer"));

check("$200 Pilot tier → pilot, NEVER admin (no purchasable admin)", () => {
  assert.equal(mapRole([20000]), "pilot");
  assert.equal(mapRole([100000]), "pilot"); // $1000 custom pledge lands at Pilot, still not admin
});

check("multiple tiers → highest amount wins (Pilot at $200, capped below admin)", () => {
  assert.equal(mapRole([500, 2000]), "deep_dreamer");
  assert.equal(mapRole([500, 2000, 20000]), "pilot");
});

check("FAIL CLOSED: $0 free tier or below-floor pledge → guest (not the paid supporter gate)", () => {
  assert.equal(mapRole([0], ["t0"]), "guest");   // $0 free-tier follower
  assert.equal(mapRole([300], ["t"]), "guest");  // $3 custom, below the $5 floor
  assert.equal(mapRole([], ["t"]), "guest");     // entitled tier but amount unresolved
});

check("roleForAmountCents thresholds (never returns admin)", () => {
  assert.equal(roleForAmountCents(0), null);
  assert.equal(roleForAmountCents(499), null);
  assert.equal(roleForAmountCents(500), "supporter");    // $5 Member
  assert.equal(roleForAmountCents(1999), "supporter");
  assert.equal(roleForAmountCents(2000), "deep_dreamer"); // $20 Pro
  assert.equal(roleForAmountCents(19999), "deep_dreamer");
  assert.equal(roleForAmountCents(20000), "pilot");       // $200 Pilot
  assert.equal(roleForAmountCents(100000), "pilot");      // $1000 custom → still Pilot, not admin
});

check("resolveRole caps ANY stray provider 'admin' down to the top PAID role (pilot), never admin", () => {
  const evilProvider = { id: "patreon", mapRole: () => "admin" };
  assert.equal(resolveRole(evilProvider, { providerId: "x" }), "pilot");
});

check("stale old-campaign owner id no longer grants admin", () => {
  assert.equal(isAdminOverride("patreon", "49294581"), false);
});

check("LANTERN_ADMIN_IDS makes the new owner admin (patreon-scoped, no cross-provider)", () => {
  process.env.LANTERN_ADMIN_IDS = "77777777,google:555";
  delete require.cache[require.resolve("../lib/auth-providers")];
  const fresh = require("../lib/auth-providers");
  assert.equal(fresh.isAdminOverride("patreon", "77777777"), true, "bare id → patreon admin");
  assert.equal(fresh.isAdminOverride("google", "77777777"), false, "NO cross-provider grant");
  assert.equal(fresh.isAdminOverride("google", "555"), true, "explicit google:555 works");
  assert.equal(fresh.isAdminOverride("patreon", "49294581"), false, "old owner id is not admin");
  // owner override wins over tier mapping:
  assert.equal(fresh.resolveRole(fresh.PROVIDERS.patreon, { providerId: "77777777", entitledAmountsCents: [] }), "admin");
  delete process.env.LANTERN_ADMIN_IDS;
  delete require.cache[require.resolve("../lib/auth-providers")];
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
