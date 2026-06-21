/**
 * Regression: SESSION_SECRET must never fall back to the committed dev default
 * beyond loopback (#867). Pure-function test of the fail-closed resolver.
 *
 * Run: node tests/test_session_secret.js
 */
const assert = require("assert");
const path = require("path");
const { resolveSessionSecret, DEFAULT_DEV_SECRET } =
  require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "session-secret"));

let passed = 0;
function ok(n) { passed++; console.log("  ✓ " + n); }

// (a) loopback dev, nothing set → dev default is allowed
assert.strictEqual(resolveSessionSecret({}), DEFAULT_DEV_SECRET);
ok("loopback dev (no PORT, no secret) → dev default");

// (b) PORT set (Railway/tunnel), no secret → fail-closed
assert.throws(() => resolveSessionSecret({ PORT: "4177" }), /SESSION_SECRET is required/);
ok("PORT set, no SESSION_SECRET → throws");

// (c) production, no secret → fail-closed
assert.throws(() => resolveSessionSecret({ NODE_ENV: "production" }), /SESSION_SECRET is required/);
ok("NODE_ENV=production, no SESSION_SECRET → throws");

// (d) non-local with the committed dev default → fail-closed
assert.throws(() => resolveSessionSecret({ PORT: "4177", SESSION_SECRET: DEFAULT_DEV_SECRET }), /dev default/);
ok("non-local + committed dev default → throws");

// (e) non-local with a real secret → returned
assert.strictEqual(resolveSessionSecret({ PORT: "4177", SESSION_SECRET: "strong-prod-secret" }), "strong-prod-secret");
ok("non-local + real SESSION_SECRET → returned");

// (f) loopback dev with a custom secret → returned (never overridden)
assert.strictEqual(resolveSessionSecret({ SESSION_SECRET: "dev-custom" }), "dev-custom");
ok("loopback dev + custom secret → returned");

console.log(`\nAll ${passed} session-secret assertions passed.`);
