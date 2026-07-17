/**
 * Regression for #2064 (p0): the email-verification / password-reset action
 * tokens (`lib/auth-tokens.js`) must never be minted or verifiable under the
 * committed dev-default secret beyond loopback, and a token forged with that
 * public default must be rejected.
 *
 * Background: the original `email-verification.js._secret()` fell back to the
 * hardcoded `"lantern-local-dev-secret-change-in-prod"` and minted forgeable
 * HMAC tokens — on a public deploy that forgot the secret, an attacker could
 * forge a `verify_email` token and hijack accounts. The token minter was
 * refactored onto the fail-closed `resolveSessionSecret()` (which throws beyond
 * loopback without a real secret, so the server refuses to boot). This test
 * pins that behavior for the TOKEN path specifically — the half of #2064's
 * acceptance ("unit test the guard") that the session-cookie test
 * (`test_session_secret.js`) does not cover.
 *
 * Run: node tests/test_auth_tokens_failclosed.js
 */
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");

const AUTH_TOKENS = path.join(__dirname, "..", "apps", "lantern-garage", "lib", "auth-tokens");
const { DEFAULT_DEV_SECRET } = require(path.join(
  __dirname, "..", "apps", "lantern-garage", "lib", "session-secret"));

// auth-tokens reads process.env at call time via resolveSessionSecret(), so we
// mutate the env per-case. Snapshot + restore the two knobs we touch.
const saved = { PORT: process.env.PORT, NODE_ENV: process.env.NODE_ENV, SESSION_SECRET: process.env.SESSION_SECRET };
function setEnv(env) {
  for (const k of ["PORT", "NODE_ENV", "SESSION_SECRET"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

let passed = 0;
function ok(n) { passed++; console.log("  ✓ " + n); }

try {
  const at = require(AUTH_TOKENS);

  // (a) loopback dev (nothing set): mint + verify round-trips (dev default allowed).
  setEnv({});
  const tok = at.createToken("verify_email", "profile-1", "user@example.com");
  // Tokens now carry exp (expiry) + jti (single-use id) claims — assert identity
  // fields exactly and the new claims by shape (exp is clock-dependent, jti random).
  const claims = at.verifyToken(tok, "verify_email");
  assert.strictEqual(claims.sub, "profile-1");
  assert.strictEqual(claims.email, "user@example.com");
  assert.ok(typeof claims.exp === "number" && claims.exp > Date.now(), "exp is a future timestamp");
  assert.ok(typeof claims.jti === "string" && claims.jti.length > 0, "jti present");
  ok("loopback dev → verify_email token round-trips (with exp + jti claims)");

  // (b) non-loopback (PORT set) without SESSION_SECRET: minting must THROW, so a
  //     forgeable token can never be issued (the server also process.exit(1)s at boot).
  setEnv({ PORT: "4177" });
  assert.throws(() => at.createToken("verify_email", "profile-1"), /SESSION_SECRET is required/);
  ok("non-loopback + no secret → createToken throws (cannot mint)");

  // (c) non-loopback with the committed dev default: minting must THROW.
  setEnv({ PORT: "4177", SESSION_SECRET: DEFAULT_DEV_SECRET });
  assert.throws(() => at.createToken("reset_password", "profile-1"), /dev default/);
  ok("non-loopback + committed dev default → createToken throws");

  // (d) the core anti-forgery guarantee: a token forged with the OLD hardcoded
  //     default (namespaced as auth-tokens does) must be REJECTED once a real
  //     secret is in force.
  setEnv({ PORT: "4177", SESSION_SECRET: "strong-prod-secret" });
  const b64url = (s) => Buffer.from(s).toString("base64url");
  const payload = b64url(JSON.stringify({ p: "verify_email", sub: "victim", e: null, exp: Date.now() + 1e6 }));
  const forgedSig = crypto
    .createHmac("sha256", "authtok:" + DEFAULT_DEV_SECRET)
    .update(payload)
    .digest("base64url");
  assert.strictEqual(at.verifyToken(`${payload}.${forgedSig}`, "verify_email"), null);
  ok("token forged with the public dev default → rejected under a real secret");

  // (e) sanity: a legitimately-minted token under the real secret still verifies.
  const legit = at.createToken("verify_email", "profile-2");
  const legitClaims = at.verifyToken(legit, "verify_email");
  assert.strictEqual(legitClaims.sub, "profile-2");
  assert.strictEqual(legitClaims.email, null);
  assert.ok(typeof legitClaims.exp === "number" && typeof legitClaims.jti === "string", "exp + jti claims present");
  ok("non-loopback + real secret → legitimate token still round-trips");

  console.log(`\nAll ${passed} auth-token fail-closed assertions passed.`);
} finally {
  setEnv(saved);
}
