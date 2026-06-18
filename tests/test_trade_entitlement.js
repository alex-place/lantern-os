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

// Isolate profile storage: user-profiles resolves data/profiles from process.cwd()
// at require time, so chdir to a fresh temp dir BEFORE requiring it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-ent-"));
process.chdir(tmp);

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
const founder = profiles.createProfile("user-founder", { role: "founder" });
assert.strictEqual(founder.entitlements.trade, false);
ok("new profile defaults entitlements.trade = false");

// 2. Founder without entitlement is denied.
assert.strictEqual(hasEntitlement(req({ patreon: { id: "user-founder", role: "founder" } }), "trade"), false);
ok("founder without grant → hasEntitlement(trade) false");

// 3. Granting trade flips it.
profiles.setEntitlement("user-founder", "trade", true);
assert.strictEqual(hasEntitlement(req({ patreon: { id: "user-founder", role: "founder" } }), "trade"), true);
ok("setEntitlement(trade,true) → hasEntitlement true");

// 4. setEntitlement does not clobber other entitlements.
profiles.setEntitlement("user-founder", "beta", true);
assert.strictEqual(hasEntitlement(req({ patreon: { id: "user-founder", role: "founder" } }), "trade"), true);
ok("setEntitlement preserves existing entitlements");

// 5. admin role passes implicitly even without a profile flag.
profiles.createProfile("user-admin", { role: "admin" });
assert.strictEqual(hasEntitlement(req({ patreon: { id: "user-admin", role: "admin" } }), "trade"), true);
ok("admin role → hasEntitlement(trade) true implicitly");

// 6. requireEntitlement: unauthenticated → 302 redirect, blocked.
let res = fakeRes();
assert.strictEqual(requireEntitlement(req(undefined), res, "trade"), false);
assert.strictEqual(res.statusCode, 302);
ok("requireEntitlement unauthenticated → 302, returns false");

// 7. requireEntitlement: authed but not entitled → 403, blocked.
profiles.createProfile("user-plain", { role: "founder" });
res = fakeRes();
assert.strictEqual(requireEntitlement(req({ patreon: { id: "user-plain", role: "founder" } }), res, "trade"), false);
assert.strictEqual(res.statusCode, 403);
assert.ok(res.body.includes("trade"));
ok("requireEntitlement authed-not-entitled → 403, returns false");

// 8. requireEntitlement: entitled → true, no write.
res = fakeRes();
assert.strictEqual(requireEntitlement(req({ patreon: { id: "user-admin", role: "admin" } }), res, "trade"), true);
assert.strictEqual(res.statusCode, null);
ok("requireEntitlement entitled → true, no response written");

console.log(`\nAll ${passed} trade-entitlement assertions passed.`);
