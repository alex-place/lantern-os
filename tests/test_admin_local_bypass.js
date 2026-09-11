/**
 * Regression test for auth bypass behavior.
 *
 * HISTORY: the old isLocalBypass() trusted a loopback socket (and dev port 4178 /
 * LANTERN_LOCAL_ADMIN) as proof of "the owner on this machine", which behind a
 * reverse proxy handed admin to the entire internet, and locally made every visitor
 * silently look like admin "Dev". That IP-based bypass was REMOVED and replaced by
 * an explicit, token-gated test-auth path (apps/lantern-garage/lib/test-auth.js).
 *
 * This test now asserts the new contract:
 *   - No token, no session → guest (isAdmin false), even on a direct loopback hit.
 *   - LANTERN_LOCAL_ADMIN has NO effect anymore.
 *   - A valid X-Test-Auth token on a DIRECT hit → the role X-Test-Role names.
 *     With NO role named it fail-closes to guest (#2645) — emulating an operator
 *     is always a deliberate, named act, never a default.
 *   - The token is refused on any PROXIED/tunnelled request (never bypassable from
 *     the internet), and refused when the token mismatches.
 *   - A real admin session still works regardless of proxy headers.
 *
 * Run: node tests/test_admin_local_bypass.js   (no server required)
 */

const assert = require("assert");
const path = require("path");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const { isAdmin } = require(LIB + "/auth-middleware");
const { getSessionRole } = require(LIB + "/session-identity");

let passed = 0;
const say = (line) => process.stdout.write(line + "\n");
function ok(name) { passed++; say("  ✓ " + name); }

const TOKEN = "test-token-abcdef123456";

// Build a mock request. `headers` defaults to none (a direct, un-proxied hit).
function req({ headers = {}, ip = "127.0.0.1", port = 4177, session, url = "/" } = {}) {
  return { headers, socket: { remoteAddress: ip, localPort: port }, session, url, method: "GET" };
}

const ADMIN_SESSION = { user: { id: "u1", role: "admin" } };

const PREV_ADMIN = process.env.LANTERN_LOCAL_ADMIN;
const PREV_TOKEN = process.env.LANTERN_TEST_AUTH_TOKEN;

try {
  // ── The removed IP bypass: even with LANTERN_LOCAL_ADMIN=1 + dev port, a direct
  //    loopback hit with no token and no session is NOT admin anymore. ──
  process.env.LANTERN_LOCAL_ADMIN = "1";
  delete process.env.LANTERN_TEST_AUTH_TOKEN;

  assert.strictEqual(isAdmin(req({ ip: "127.0.0.1", port: 4177 })), false);
  ok("direct loopback, LANTERN_LOCAL_ADMIN=1, no token → NOT admin (bypass removed)");

  assert.strictEqual(isAdmin(req({ ip: "::1", port: 4178 })), false);
  ok("direct dev-port 4178 hit, no token → NOT admin (bypass removed)");

  // ── Token-gated test-auth ──
  process.env.LANTERN_TEST_AUTH_TOKEN = TOKEN;

  // Valid token but NO role named → fail-closed to guest (#2645). This test used to
  // assert "default role → admin"; that was the pre-#2645 contract, and the test was
  // wired into no CI lane, so it silently rotted when the default flipped.
  assert.strictEqual(isAdmin(req({ headers: { "x-test-auth": TOKEN } })), false);
  ok("valid X-Test-Auth token, no role named → NOT admin (#2645 fail-closed)");
  assert.strictEqual(getSessionRole(req({ headers: { "x-test-auth": TOKEN } })), "guest");
  ok("valid token, no role named → emulated role is guest");

  // Naming the role grants exactly that role — header and ?__test= query forms.
  assert.strictEqual(
    isAdmin(req({ headers: { "x-test-auth": TOKEN, "x-test-role": "admin" } })),
    true
  );
  ok("X-Test-Role=admin → admin");
  assert.strictEqual(
    isAdmin(req({ url: "/orchestration.html?__test=" + TOKEN + "&__test_role=admin" })),
    true
  );
  ok("?__test= + __test_role=admin (browser-navigation path) → admin");

  // Every roster role emulates as itself (the picker offers Free / Pro / Pilot /
  // Admin / Tech Support)…
  for (const role of ["supporter", "deep_dreamer", "pilot", "tech_support"]) {
    assert.strictEqual(
      getSessionRole(req({ headers: { "x-test-auth": TOKEN, "x-test-role": role } })),
      role,
      `role ${role} should emulate as itself`
    );
  }
  ok("supporter / deep_dreamer / pilot / tech_support each emulate as themselves");
  // …and the retired legacy alias does not: "founder" left the roster when the picker
  // was de-duped (it rendered as a second identical Pro), so it now normalizes to
  // guest like any unknown role.
  assert.strictEqual(
    getSessionRole(req({ headers: { "x-test-auth": TOKEN, "x-test-role": "founder" } })),
    "guest"
  );
  ok("X-Test-Role=founder (retired alias) → fail-closed to guest");

  // Role override: X-Test-Role downgrades the emulated identity.
  assert.strictEqual(
    getSessionRole(req({ headers: { "x-test-auth": TOKEN, "x-test-role": "supporter" } })),
    "supporter"
  );
  ok("X-Test-Role=supporter → emulated role is supporter (not admin)");
  assert.strictEqual(
    isAdmin(req({ headers: { "x-test-auth": TOKEN, "x-test-role": "supporter" } })),
    false
  );
  ok("X-Test-Role=supporter → NOT admin");

  // Wrong token → denied.
  assert.strictEqual(isAdmin(req({ headers: { "x-test-auth": "wrong-token" } })), false);
  ok("mismatched token → NOT admin");

  // Proxied/tunnelled traffic must NEVER honor the token, even if correct.
  for (const h of [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "cf-ray",
    "true-client-ip",
  ]) {
    assert.strictEqual(
      isAdmin(req({ headers: { "x-test-auth": TOKEN, [h]: "203.0.113.9" } })),
      false,
      `proxy header ${h} must reject the test token`
    );
    ok(`valid token + proxy header ${h} → NOT admin`);
  }

  // Mechanism OFF (no env token) → token header is inert.
  delete process.env.LANTERN_TEST_AUTH_TOKEN;
  assert.strictEqual(isAdmin(req({ headers: { "x-test-auth": TOKEN } })), false);
  ok("token header with mechanism disabled → NOT admin");

  // ── A real admin session still works, independent of the bypass, even proxied. ──
  assert.strictEqual(isAdmin(req({ ip: "203.0.113.9", port: 443, session: ADMIN_SESSION })), true);
  ok("real admin session → admin");
  assert.strictEqual(
    isAdmin(req({ headers: { "cf-connecting-ip": "203.0.113.9" }, session: ADMIN_SESSION })),
    true
  );
  ok("real admin session behind proxy → admin");

  say(`\nAll ${passed} auth-bypass assertions passed.`);
} finally {
  if (PREV_ADMIN === undefined) delete process.env.LANTERN_LOCAL_ADMIN;
  else process.env.LANTERN_LOCAL_ADMIN = PREV_ADMIN;
  if (PREV_TOKEN === undefined) delete process.env.LANTERN_TEST_AUTH_TOKEN;
  else process.env.LANTERN_TEST_AUTH_TOKEN = PREV_TOKEN;
}
