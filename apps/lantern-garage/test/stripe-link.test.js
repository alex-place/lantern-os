// Stripe subscription LINKING — the pure decisions behind POST /api/billing/link
// (claim a card sub bought before the account existed) and the pre-checkout adopt
// guard in routes/billing.js.
//
// The load-bearing invariants:
//   • only a VERIFIED email can prove subscription ownership (verifiedEmailOf —
//     the ADR-0016 trust gate reused; an unverified email must never claim a sub);
//   • pickLinkableSubscription prefers an active/trialing sub, accepts a dunning
//     one, and never links a terminal or unclassifiable one.
//
// Run: node apps/lantern-garage/test/stripe-link.test.js  (isolates profiles to a temp cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-stripe-link-"));
process.chdir(_tmpDataRoot);
// The data root is module-anchored, not cwd-derived (#3088) — isolate the store
// explicitly so this test never writes into the real repo data/ tree.
process.env.LANTERN_DATA_DIR = path.join(_tmpDataRoot, "data");
const { verifiedEmailOf } = require(path.join(__dirname, "..", "lib", "user-profiles"));
const { pickLinkableSubscription } = require(path.join(__dirname, "..", "lib", "stripe-billing"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// ── verifiedEmailOf: only proven ownership counts ────────────────────────────
check("verified root email is returned", () => {
  assert.equal(verifiedEmailOf({ email: "a@x.com", emailVerified: true }), "a@x.com");
});

check("UNVERIFIED root email is refused (entitlement-theft gate)", () => {
  assert.equal(verifiedEmailOf({ email: "a@x.com", emailVerified: false }), null);
  assert.equal(verifiedEmailOf({ email: "a@x.com" }), null);
});

check("falls back to a VERIFIED identity email when the root is unverified", () => {
  const p = {
    email: "root@x.com", emailVerified: false,
    identities: [
      { provider: "patreon", providerId: "1", email: "pat@x.com", emailVerified: false },
      { provider: "google", providerId: "2", email: "goog@x.com", emailVerified: true },
    ],
  };
  assert.equal(verifiedEmailOf(p), "goog@x.com");
});

check("no verified email anywhere → null; null/empty profile → null", () => {
  assert.equal(verifiedEmailOf({ email: "a@x.com", identities: [{ provider: "local", providerId: "a@x.com", email: "a@x.com", emailVerified: false }] }), null);
  assert.equal(verifiedEmailOf(null), null);
  assert.equal(verifiedEmailOf({}), null);
});

check("verified flag without an email string is not a match", () => {
  assert.equal(verifiedEmailOf({ email: "", emailVerified: true }), null);
  assert.equal(verifiedEmailOf({ identities: [{ provider: "google", providerId: "2", email: null, emailVerified: true }] }), null);
});

// ── pickLinkableSubscription: what is safe to adopt ──────────────────────────
const sub = (id, status) => ({ id, status });

check("prefers an active sub over a dunning one, regardless of order", () => {
  assert.equal(pickLinkableSubscription([sub("s1", "past_due"), sub("s2", "active")]).id, "s2");
  assert.equal(pickLinkableSubscription([sub("s1", "active"), sub("s2", "past_due")]).id, "s1");
  assert.equal(pickLinkableSubscription([sub("s1", "trialing")]).id, "s1");
});

check("accepts a dunning sub when no active one exists (webhook keeps access through retries)", () => {
  assert.equal(pickLinkableSubscription([sub("s1", "canceled"), sub("s2", "past_due")]).id, "s2");
  assert.equal(pickLinkableSubscription([sub("s1", "incomplete")]).id, "s1");
});

check("never links a terminal sub", () => {
  assert.equal(pickLinkableSubscription([sub("s1", "canceled"), sub("s2", "unpaid"), sub("s3", "incomplete_expired"), sub("s4", "paused")]), null);
});

check("never links what it can't classify: missing status / junk entries are skipped", () => {
  assert.equal(pickLinkableSubscription([sub("s1", ""), sub("s2", null), null, undefined]), null);
  assert.equal(pickLinkableSubscription([null, sub("s2", "active")]).id, "s2");
});

check("empty / absent list → null", () => {
  assert.equal(pickLinkableSubscription([]), null);
  assert.equal(pickLinkableSubscription(null), null);
});

process.exitCode = failures ? 1 : 0;
console.error(failures ? `\n${failures} FAILED` : "\nall ok");
