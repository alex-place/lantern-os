// Role lifecycle: the tier AUTHORITY (Patreon) re-baselines a NON-staff role to the live
// entitlement on login, so a lapsed/downgraded member loses the paid tier — but ONLY on an
// authoritative read (u.entitlementResolved), and NEVER for staff roles or a guest-mapping
// provider (Google/Discord), and never mass-locks-out on a partial/misconfigured read.
//
// Run: node apps/lantern-garage/test/patreon-role-demotion.test.js  (isolates profiles to a temp cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// user-profiles resolves data/profiles from process.cwd() at require time — chdir first.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "lantern-demote-")));
const profiles = require(path.join(__dirname, "..", "lib", "user-profiles"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Seed a profile at a given role by writing it directly, then re-attest via a login.
let n = 0;
function seed(role) {
  const id = "u" + ++n;
  profiles.createProfile(id, { role, source: "patreon",
    identities: [{ provider: "patreon", providerId: id, email: null, emailVerified: false }] });
  return id;
}
// A patreon login result: role = what resolveRole produced this login; resolved = authoritative read.
const login = (id, provider, role, resolved) =>
  profiles.getOrCreateFromIdentity(provider, { providerId: id, entitlementResolved: resolved }, role).profile.role;

check("lapsed deep_dreamer, authoritative guest read → demoted to guest", () => {
  const id = seed("deep_dreamer");
  assert.equal(login(id, "patreon", "guest", true), "guest");
});

check("downgraded deep_dreamer → supporter (authoritative) → supporter", () => {
  const id = seed("deep_dreamer");
  assert.equal(login(id, "patreon", "supporter", true), "supporter");
});

check("NON-authoritative read (misconfig / partial) does NOT demote — keeps deep_dreamer", () => {
  const id = seed("deep_dreamer");
  assert.equal(login(id, "patreon", "guest", false), "deep_dreamer");
});

check("staff role admin is NEVER demoted by a login", () => {
  const id = seed("admin");
  assert.equal(login(id, "patreon", "guest", true), "admin");
});

check("staff role tech_support is NEVER demoted by a login", () => {
  const id = seed("tech_support");
  assert.equal(login(id, "patreon", "guest", true), "tech_support");
});

check("Google/Discord login never downgrades a Patreon-earned tier (monotonic)", () => {
  const id = seed("deep_dreamer");
  // getOrCreateFromIdentity keys on (provider, providerId); use a google identity on same id path
  profiles.linkIdentity(id, "google", id, null, false);
  assert.equal(login(id, "google", "guest", true), "deep_dreamer");
});

check("upgrade still raises (supporter → deep_dreamer on authoritative read)", () => {
  const id = seed("supporter");
  assert.equal(login(id, "patreon", "deep_dreamer", true), "deep_dreamer");
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
