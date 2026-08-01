/**
 * Regression: a sign-in that cannot persist must FAIL, not return ok:true (#3010).
 *
 * With `cookie.secure` true on a plain-http request, express-session saves the session
 * to the store and silently emits no Set-Cookie at all — so every login returned
 * `200 {ok:true}` and left the browser a guest, with no error on any path. The guard in
 * session-identity turns that into a hard, named failure.
 *
 * Run: node tests/test_secure_cookie_guard.js   (no server)
 */

const assert = require("assert");
const path = require("path");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const { establishSession, sessionCookieUndeliverable } = require(path.join(LIB, "session-identity"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

// A session double with the express-session surface establishSession touches.
function mkReq({ secure, encrypted = false, headers = {} } = {}) {
  return {
    headers,
    socket: { encrypted },
    session: {
      cookie: { secure },
      regenerate(cb) { cb(null); },
      save(cb) { this._saved = true; cb(null); },
    },
  };
}
function establish(req) {
  let error = null;
  establishSession(req, { id: "u1", role: "admin" }, (err) => { error = err; });
  return error;
}

// 1. secure:true over plain http — the silent-failure combination.
const bad = mkReq({ secure: true });
assert.strictEqual(sessionCookieUndeliverable(bad), true);
const err = establish(bad);
assert.ok(err, "establishSession reports an error");
assert.strictEqual(err.code, "secure_cookie_on_http");
assert.ok(!bad.session.user, "no identity is written when the cookie cannot be delivered");
ok("secure cookie + http → named failure, session not established");

// 2. secure:"auto" over http — the shipped non-production config. Resolves to a
//    non-Secure cookie, so the login is real and must go through.
const auto = mkReq({ secure: "auto" });
assert.strictEqual(sessionCookieUndeliverable(auto), false);
assert.strictEqual(establish(auto), null);
assert.strictEqual(auto.session.user.id, "u1");
ok('secure:"auto" over http → login succeeds');

// 3. secure:true over real TLS — production, cookie is deliverable.
const tls = mkReq({ secure: true, encrypted: true });
assert.strictEqual(sessionCookieUndeliverable(tls), false);
assert.strictEqual(establish(tls), null);
ok("secure cookie + TLS socket → login succeeds");

// 4. secure:true behind a TLS-terminating proxy (proxy:true honours X-Forwarded-Proto).
const proxied = mkReq({ secure: true, headers: { "x-forwarded-proto": "https,http" } });
assert.strictEqual(sessionCookieUndeliverable(proxied), false);
assert.strictEqual(establish(proxied), null);
ok("secure cookie + X-Forwarded-Proto https → login succeeds");

// 5. …but a proxy that reports http is NOT secure — fail loudly rather than pretend.
const downgraded = mkReq({ secure: true, headers: { "x-forwarded-proto": "http" } });
assert.strictEqual(sessionCookieUndeliverable(downgraded), true);
assert.strictEqual(establish(downgraded).code, "secure_cookie_on_http");
ok("secure cookie + X-Forwarded-Proto http → named failure");

console.log(`\nAll ${passed} secure-cookie-guard assertions passed.`);
