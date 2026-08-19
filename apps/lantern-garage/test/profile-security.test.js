// Security invariants for the profile layer added by the audit fixes:
//   #2606 verifiedEmailOf must NOT trust an `emailAssumed` (no-mailer) verification
//   #2608 a deleted profile is a tombstone honored at every read/grant boundary
//
// Run: node apps/lantern-garage/test/profile-security.test.js  (isolates to a temp cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-profsec-"));
process.chdir(_tmpRoot);
process.env.UNISONA_STATE_DIR = _tmpRoot; // #3088: user-profiles roots at dataRoot(), not cwd
const p = require(path.join(__dirname, "..", "lib", "user-profiles"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
let n = 0;
const mk = (extra = {}) => p.createProfile("u" + ++n, extra);

// ── #2606 verifiedEmailOf ────────────────────────────────────────────────────
check("genuinely verified root email counts", () => {
  const prof = mk({ email: "real@x.com", emailVerified: true });
  assert.equal(p.verifiedEmailOf(prof), "real@x.com");
});
check("emailAssumed (no-mailer admit) root email is REFUSED (#2606)", () => {
  const prof = mk({ email: "spoof@x.com", emailVerified: true, emailAssumed: true });
  assert.equal(p.verifiedEmailOf(prof), null, "assumed verification must not prove ownership");
});
check("a verified OAuth identity still counts even when the root is assumed", () => {
  const prof = mk({
    email: "assumed@x.com", emailVerified: true, emailAssumed: true,
    identities: [{ provider: "google", providerId: "g1", email: "google@x.com", emailVerified: true }],
  });
  assert.equal(p.verifiedEmailOf(prof), "google@x.com");
});
check("a real verification clears the assumed flag (link/OAuth path)", () => {
  const prof = mk({ email: "user@x.com", emailVerified: true, emailAssumed: true });
  p.updateProfile(prof.id, { emailVerified: true, emailAssumed: false });
  assert.equal(p.verifiedEmailOf(p.getProfile(prof.id)), "user@x.com");
});

// ── #2608 delete tombstone ───────────────────────────────────────────────────
check("getProfile returns null after delete; isProfileDeleted reports it", () => {
  const prof = mk({ email: "gone@x.com", role: "deep_dreamer" });
  assert.ok(p.getProfile(prof.id), "exists before delete");
  p.deleteProfile(prof.id);
  assert.equal(p.getProfile(prof.id), null, "deleted profile no longer resolves");
  assert.equal(p.isProfileDeleted(prof.id), true);
});
check("a deleted profile never receives a billing grant (getProfileByStripeCustomer skips it)", () => {
  const prof = mk({ email: "cust@x.com", stripeCustomerId: "cus_DEL" });
  p.deleteProfile(prof.id);
  assert.equal(p.getProfileByStripeCustomer("cus_DEL"), null, "webhook can't resolve a tombstone");
});
check("updateProfile on a deleted profile is a no-op (no resurrection via write)", () => {
  const prof = mk({ email: "res@x.com" });
  p.deleteProfile(prof.id);
  assert.equal(p.updateProfile(prof.id, { role: "admin" }), null);
  assert.equal(p.getProfile(prof.id), null);
});
check("Patreon re-login does NOT resurrect a deleted account (fresh id, tombstone intact)", () => {
  const { profile: first } = p.getOrCreateFromIdentity("patreon", { providerId: "pat-99", email: "pat@x.com" }, "supporter");
  p.deleteProfile(first.id);
  const { profile: second, created } = p.getOrCreateFromIdentity("patreon", { providerId: "pat-99", email: "pat@x.com" }, "supporter");
  assert.ok(second, "returning user gets a profile");
  assert.notEqual(second.id, first.id, "it is a NEW profile, not the resurrected tombstone");
  assert.equal(p.isProfileDeleted(first.id), true, "the original tombstone is still dead");
});

// ── #2623 unlinkIdentity counts a local password as a login method ───────────
check("a password-holder can unlink their only OAuth provider (credential counts, #2623)", () => {
  const prof = p.createProfile("u-unlink-" + ++n, {
    email: "pw@x.com",
    credential: p.hashPassword("hunter2hunter2"),
    identities: [{ provider: "google", providerId: "g9", email: "pw@x.com", emailVerified: true }],
  });
  const res = p.unlinkIdentity(prof.id, "google");
  assert.ok(res.profile, "unlink allowed because the local password remains a login method");
  assert.ok(!res.error, "not wrongly blocked as last_login_method");
});

// ── #2628 CSF import does not resurrect deleted accounts ─────────────────────
check("importFromCSF skips tombstones (no resurrection, #2628)", () => {
  const csf = { format: "CSF-1.0", type: "user-profiles", records: [
    { id: "imp-live-" + ++n, email: "live@x.com", role: "guest", metadata: {} },
    { id: "imp-dead-" + ++n, email: "dead@x.com", role: "guest", deleted: true, metadata: {} },
  ] };
  const liveId = csf.records[0].id, deadId = csf.records[1].id;
  const count = p.importFromCSF(csf);
  assert.equal(count, 1, "only the live record is imported");
  assert.ok(p.getProfile(liveId), "live record imported");
  assert.equal(p.getProfile(deadId), null, "tombstoned record NOT resurrected");
});

process.exitCode = failures ? 1 : 0;
console.error(failures ? `\n${failures} FAILED` : "\nall ok");
