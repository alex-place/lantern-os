/**
 * ADR-0016 unit tests — provider-agnostic identity, verified-both account linking
 * (pre-hijacking defense, arXiv:2205.10174), and scrypt local credentials.
 *
 * Uses an isolated temp data dir. Run:
 *   node apps/lantern-garage/tests/test_identity_linking.js
 */
"use strict";
const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-"));
process.chdir(tmp);

const up = require(path.join(__dirname, "..", "lib", "user-profiles.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  - " + n); } else { fail++; console.log("  FAIL- " + n); } };

// ── scrypt ──
const cred = up.hashPassword("hunter2long");
ok("scrypt verifies correct password", up.verifyPassword("hunter2long", cred));
ok("scrypt rejects wrong password", !up.verifyPassword("nope", cred));
ok("scrypt rejects against empty credential", !up.verifyPassword("x", null));
ok("credential shape is scrypt", cred.algo === "scrypt" && cred.salt && cred.hash);

// ── local accounts ──
const r = up.createLocalAccount("alice@example.com", "password123", "Alice");
ok("local account created", !!r.profile && !!r.profile.id);
ok("local account starts UNVERIFIED", r.profile.emailVerified === false);
ok("local login succeeds", !!up.verifyLocalLogin("alice@example.com", "password123"));
ok("local login wrong password fails", up.verifyLocalLogin("alice@example.com", "x") === null);
ok("duplicate local email is rejected", up.createLocalAccount("alice@example.com", "another").error === "email_taken");
ok("publicProfile strips credential", up.publicProfile(r.profile).credential === undefined);

// ── PRE-HIJACKING DEFENSE ──
// A verified Google login whose email matches an UNVERIFIED local account must NOT
// merge — it creates a fresh profile. Otherwise an attacker who pre-registered the
// victim's email locally would capture the victim's Google login.
const g = up.getOrCreateFromIdentity("google", { providerId: "g-1", email: "alice@example.com", emailVerified: true, name: "Alice G" }, "guest");
ok("verified Google vs UNVERIFIED local email → NEW profile (no hijack)", g.created === true && g.profile.id !== r.profile.id);
ok("new google profile is email-verified", g.profile.emailVerified === true);

// Two verified providers sharing an email DO auto-link (both sides verified).
const d = up.getOrCreateFromIdentity("discord", { providerId: "d-9", email: "alice@example.com", emailVerified: true, name: "Alice D" }, "guest");
ok("verified Discord auto-links to verified Google profile", d.linked === true && d.profile.id === g.profile.id);

// Patreon email is treated as UNVERIFIED → never auto-links.
const pat = up.getOrCreateFromIdentity("patreon", { providerId: "49294581", email: "alice@example.com", emailVerified: false, name: "AP" }, "admin");
ok("unverified Patreon email does NOT auto-link", pat.created === true && pat.profile.id === "49294581");
ok("patreon profile keyed by patreon id (backcompat)", pat.profile.patreonId === "49294581");

// Idempotent login: same identity returns same profile, updates role.
const g2 = up.getOrCreateFromIdentity("google", { providerId: "g-1", email: "alice@example.com", emailVerified: true }, "supporter");
ok("same identity is idempotent", g2.created === false && g2.linked === false && g2.profile.id === g.profile.id);
ok("role refreshed on re-login", g2.profile.role === "supporter");

// Lookups
ok("getProfileByIdentity finds discord", up.getProfileByIdentity("discord", "d-9").id === g.profile.id);
ok("getProfileByIdentity finds patreon by legacy id", up.getProfileByIdentity("patreon", "49294581").id === "49294581");
ok("getProfileByEmail verifiedOnly returns verified profile", up.getProfileByEmail("alice@example.com", { verifiedOnly: true }).id === g.profile.id);

// Backward-compat wrappers still work.
ok("getOrCreateFromPatreon returns a profile", up.getOrCreateFromPatreon({ id: "p-2", name: "P2", email: "p2@x.com", primaryTier: "t" }, "supporter").id === "p-2");

// ── SECURITY REGRESSIONS (ADR-0016 review) ──

// Register-takeover: an OAuth profile with no local password must NOT be claimable
// by registering a local account with the same email.
const oauthOnly = up.getOrCreateFromIdentity("google", { providerId: "g-victim", email: "victim@example.com", emailVerified: true, name: "Victim" }, "guest");
const attack = up.createLocalAccount("victim@example.com", "attacker-pw", "Attacker");
ok("register CANNOT claim an existing OAuth profile (takeover blocked)", attack.error === "email_taken");
ok("victim OAuth profile still has no credential after attack", !up.getProfile(oauthOnly.profile.id).credential);
ok("attacker cannot log into victim's profile", up.verifyLocalLogin("victim@example.com", "attacker-pw") === null);

// exportToCSF must never carry scrypt credentials.
const csf = up.exportToCSF();
const anyCredInExport = csf.records.some((r) => r.credential !== undefined);
ok("exportToCSF strips all credentials", anyCredInExport === false);

// verifyLocalLogin still authenticates a genuine local account after the fixes.
ok("genuine local login still works post-hardening", !!up.verifyLocalLogin("alice@example.com", "password123"));
ok("login for unknown email returns null (no crash on dummy scrypt)", up.verifyLocalLogin("nobody@nowhere.com", "x") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
