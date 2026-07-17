"use strict";

/**
 * test/local-account-signup.test.js
 *
 * Regression for #2703 — a dormant, UNVERIFIED, local-only signup must not
 * permanently block re-registration with "an account already exists". Re-registering
 * the same email should be idempotent (refresh the credential, keep the same profile,
 * signal reuse) so the verification link can be re-issued. Verified or OAuth-linked
 * profiles still return `email_taken` (the ADR-0016 anti account-takeover defense).
 *
 * user-profiles.js persists under `${cwd}/data/profiles`, so we run in an isolated
 * temp cwd and load a FRESH copy of the module (its in-memory cache is per-require).
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/local-account-signup.test.js
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let profiles;
let tmpDir;
let origCwd;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-profiles-"));
  process.chdir(tmpDir);
  // Fresh module instance bound to this cwd (bypass require cache).
  const resolved = require.resolve("../lib/user-profiles");
  delete require.cache[resolved];
  profiles = require("../lib/user-profiles");
});

after(() => {
  process.chdir(origCwd);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("re-registering a dormant unverified local email is idempotent (#2703)", () => {
  const email = "newbie@example.com";

  const first = profiles.createLocalAccount(email, "hunter2pass", "Newbie");
  assert.ok(first.profile, "first signup creates a profile");
  assert.equal(first.reused, undefined, "first signup is not a reuse");
  assert.equal(first.profile.emailVerified, false, "local accounts start unverified");

  // Second attempt with the same (still unverified) email — must NOT be email_taken.
  const second = profiles.createLocalAccount(email, "differentpass", "Newbie");
  assert.equal(second.error, undefined, "no email_taken for a dormant unverified signup");
  assert.ok(second.profile, "re-registration returns a profile");
  assert.equal(second.reused, true, "re-registration is flagged as a reuse");
  assert.equal(second.profile.id, first.profile.id, "reuses the same dormant profile");

  // The refreshed password is what verifies now.
  assert.ok(profiles.verifyLocalLogin(email, "differentpass"), "new password verifies");
  assert.equal(profiles.verifyLocalLogin(email, "hunter2pass"), null, "old password no longer verifies");
});

test("a VERIFIED local email still returns email_taken (#2703 anti-takeover)", () => {
  const email = "verified@example.com";
  const { profile } = profiles.createLocalAccount(email, "hunter2pass", "V");
  // Simulate clicking the confirmation link.
  profiles.updateProfile(profile.id, { emailVerified: true });

  const again = profiles.createLocalAccount(email, "attackerpass", "V");
  assert.equal(again.error, "email_taken", "verified email cannot be re-registered");
  assert.equal(again.profile, undefined);
});

test("an OAuth-linked email still returns email_taken (#2703 anti-takeover)", () => {
  const email = "oauth@example.com";
  // A Google identity owns this email; no local credential.
  const { profile } = profiles.getOrCreateFromIdentity(
    "google",
    { providerId: "g-123", email, emailVerified: true, name: "G" },
    "guest"
  );
  assert.ok(profile, "oauth profile created");

  const attempt = profiles.createLocalAccount(email, "attackerpass", "G");
  assert.equal(attempt.error, "email_taken", "cannot attach a local password to an OAuth profile");
});
