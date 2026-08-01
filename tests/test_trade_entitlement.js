/**
 * Unit tests for per-user trade entitlement gating (#695).
 * Covers: profile entitlement default, setEntitlement, and
 * auth-middleware hasEntitlement / requireEntitlement decision logic.
 *
 * Run: node tests/test_trade_entitlement.js
 * No server required. Profile writes are isolated to a temp cwd.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate profile storage in a fresh temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-ent-"));
process.chdir(tmp);
// The data root is resolved from the module tree, not the cwd (#3088) — isolate the
// store with UNISONA_STATE_DIR, set BEFORE any lib require reads it.
process.env.UNISONA_STATE_DIR = tmp;

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const profiles = require(path.join(LIB, "user-profiles"));
const { hasEntitlement, requireEntitlement } = require(path.join(LIB, "auth-middleware"));

let passed = 0;
function ok(name) { passed++; console.log("  ✓ " + name); }

// Fake response that records what was written.
function fakeRes() {
  return {
    statusCode: null, headers: null, body: "",
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; },
    end(b) { if (b) this.body += b; },
  };
}
// Request with no loopback bypass (remote-looking socket).
function req(session) {
  return { session, socket: { localPort: 4177, remoteAddress: "203.0.113.9" } };
}

// 1. New profile defaults trade=false (opt-in).
const founder = profiles.createProfile("user-founder", { role: "deep_dreamer" });
assert.strictEqual(founder.entitlements.trade, false);
ok("new profile defaults entitlements.trade = false");

// 2. A FREE-tier role without an explicit grant is denied. (This is the real
// "opt-in" case now: per the 2026-07-31 tier decision, trade is a Pro-tier unlock,
// so the denied case must be a role BELOW Pro — supporter sits at the Free floor.)
profiles.createProfile("user-free", { role: "supporter" });
assert.strictEqual(hasEntitlement(req({ user: { id: "user-free", role: "supporter" } }), "trade"), false);
ok("free role without grant → hasEntitlement(trade) false");

// 2b. Pro (deep_dreamer) gets trade BY TIER, with no per-account grant — the current
// product model (auth-middleware: roleLevel(role) >= roleLevel("deep_dreamer")).
// The old assertion here demanded false, encoding the retired opt-in-only model (#3130).
assert.strictEqual(hasEntitlement(req({ user: { id: "user-founder", role: "deep_dreamer" } }), "trade"), true);
ok("Pro tier (deep_dreamer) → hasEntitlement(trade) true by tier, no grant needed");

// 3. Granting trade to a free account flips it (per-account override below the tier).
profiles.setEntitlement("user-free", "trade", true);
assert.strictEqual(hasEntitlement(req({ user: { id: "user-free", role: "supporter" } }), "trade"), true);
ok("setEntitlement(trade,true) on a free account → hasEntitlement true");

// 4. setEntitlement does not clobber other entitlements.
profiles.setEntitlement("user-free", "beta", true);
assert.strictEqual(hasEntitlement(req({ user: { id: "user-free", role: "supporter" } }), "trade"), true);
ok("setEntitlement preserves existing entitlements");

// 5. admin role passes implicitly even without a profile flag.
profiles.createProfile("user-admin", { role: "admin" });
assert.strictEqual(hasEntitlement(req({ user: { id: "user-admin", role: "admin" } }), "trade"), true);
ok("admin role → hasEntitlement(trade) true implicitly");

// 6. requireEntitlement: unauthenticated → 302 redirect, blocked.
let res = fakeRes();
assert.strictEqual(requireEntitlement(req(undefined), res, "trade"), false);
assert.strictEqual(res.statusCode, 302);
ok("requireEntitlement unauthenticated → 302, returns false");

// 7. requireEntitlement: authed but not entitled → 403, blocked.
profiles.createProfile("user-plain", { role: "supporter" });
res = fakeRes();
assert.strictEqual(requireEntitlement(req({ user: { id: "user-plain", role: "supporter" } }), res, "trade"), false);
assert.strictEqual(res.statusCode, 403);
assert.ok(res.body.includes("trade"));
ok("requireEntitlement authed-not-entitled → 403, returns false");

// 8. requireEntitlement: entitled → true, no write.
res = fakeRes();
assert.strictEqual(requireEntitlement(req({ user: { id: "user-admin", role: "admin" } }), res, "trade"), true);
assert.strictEqual(res.statusCode, null);
ok("requireEntitlement entitled → true, no response written");

console.log(`\nAll ${passed} trade-entitlement assertions passed.`);
