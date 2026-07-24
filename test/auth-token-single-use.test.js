// Action tokens (verify-email / reset-password) are single-use: once spent, a replay
// within the TTL must be rejected, so a leaked link can't reset the password again after
// the legitimate user already used it (#2614).
//
// Run: node test/auth-token-single-use.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the consumed-tokens ledger to a temp cwd (it's cwd-relative).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "authtok-")));
process.env.SESSION_SECRET = "test-secret-for-tokens";
const { createToken, verifyToken, isConsumed, consumeToken } = require("../lib/auth-tokens");

let failures = 0;
function check(name, fn) { try { fn(); console.error("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

check("a fresh token verifies and carries a jti", () => {
  const t = createToken("reset_password", "user-1", "u@x.com");
  const p = verifyToken(t, "reset_password");
  assert.ok(p && p.sub === "user-1", "verifies");
  assert.ok(p.jti, "has a jti");
  assert.equal(isConsumed(p.jti), false, "not consumed yet");
});

check("consumeToken burns it: first call true, replay false", () => {
  const t = createToken("reset_password", "user-2");
  const p = verifyToken(t, "reset_password");
  assert.equal(consumeToken(p.jti, p.exp), true, "first use consumes");
  assert.equal(isConsumed(p.jti), true, "now marked consumed");
  assert.equal(consumeToken(p.jti, p.exp), false, "replay is rejected");
});

check("two distinct tokens don't collide", () => {
  const a = verifyToken(createToken("verify_email", "u3"), "verify_email");
  const b = verifyToken(createToken("verify_email", "u3"), "verify_email");
  assert.notEqual(a.jti, b.jti);
  consumeToken(a.jti, a.exp);
  assert.equal(isConsumed(a.jti), true);
  assert.equal(isConsumed(b.jti), false, "the other token is still usable");
});

check("wrong purpose / tampered token still fails to verify", () => {
  const t = createToken("reset_password", "u4");
  assert.equal(verifyToken(t, "verify_email"), null, "purpose mismatch → null");
  assert.equal(verifyToken(t.slice(0, -2) + "xx", "reset_password"), null, "tampered sig → null");
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
