// Patreon tier → role is gated by PLEDGE AMOUNT, not campaign-specific tier IDs, so a
// move to a new Patreon campaign (patreon.com/cw/UnisonaAI) doesn't silently break
// role gating. $5→supporter, $20→deep_dreamer (trading unlock), $200→admin.
//
// Run: node apps/lantern-garage/test/patreon-tier-amount.test.js
const assert = require("assert");
const { PROVIDERS, roleForAmountCents, isAdminOverride, resolveRole } = require("../lib/auth-providers");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const mapRole = (amountsCents, tierIds = ["t"]) =>
  PROVIDERS.patreon.mapRole({ entitledAmountsCents: amountsCents, memberships: tierIds });

check("no membership → guest", () => assert.equal(mapRole([], []), "guest"));
check("$5 → supporter", () => assert.equal(mapRole([500]), "supporter"));
check("$20 → deep_dreamer (trading unlock)", () => assert.equal(mapRole([2000]), "deep_dreamer"));
check("$200 → admin", () => assert.equal(mapRole([20000]), "admin"));

check("multiple tiers → highest amount wins", () => {
  assert.equal(mapRole([500, 2000]), "deep_dreamer");
  assert.equal(mapRole([500, 2000, 20000]), "admin");
});

check("custom pledge above a tier still maps up", () => {
  assert.equal(mapRole([25000]), "admin");       // $250 ≥ $200
  assert.equal(mapRole([2500]), "deep_dreamer");  // $25 ≥ $20
});

check("membership present but amount missing/below floor → supporter (not guest)", () => {
  assert.equal(mapRole([], ["t"]), "supporter");   // entitled but amount not resolved
  assert.equal(mapRole([300], ["t"]), "supporter"); // $3 custom, below the $5 floor
});

check("roleForAmountCents thresholds", () => {
  assert.equal(roleForAmountCents(0), null);
  assert.equal(roleForAmountCents(499), null);
  assert.equal(roleForAmountCents(500), "supporter");
  assert.equal(roleForAmountCents(1999), "supporter");
  assert.equal(roleForAmountCents(2000), "deep_dreamer");
  assert.equal(roleForAmountCents(19999), "deep_dreamer");
  assert.equal(roleForAmountCents(20000), "admin");
});

check("stale old-campaign owner id no longer grants admin", () => {
  assert.equal(isAdminOverride("patreon", "49294581"), false);
});

check("LANTERN_ADMIN_IDS sets the new owner as admin (env, not hardcoded)", () => {
  // The override set is built at module load, so load a fresh copy with the env set.
  process.env.LANTERN_ADMIN_IDS = "77777777";
  delete require.cache[require.resolve("../lib/auth-providers")];
  const fresh = require("../lib/auth-providers");
  assert.equal(fresh.isAdminOverride("patreon", "77777777"), true, "configured owner id is admin");
  assert.equal(fresh.isAdminOverride("patreon", "49294581"), false, "old owner id is not");
  delete process.env.LANTERN_ADMIN_IDS;
  delete require.cache[require.resolve("../lib/auth-providers")]; // restore clean module for other suites
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
