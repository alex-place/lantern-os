/**
 * Regression test for the local-admin bypass behind a reverse proxy / tunnel.
 *
 * lantern-os.net is fronted by Cloudflare, so every visitor reaches Node from a
 * loopback socket. The old isLocalBypass() trusted that loopback address (and
 * the dev port 4178) as proof of "the owner on this machine", which handed admin
 * — read + write of feature flags and nav visibility via /api/admin/* — to the
 * entire internet. The fix: any request carrying a proxy/forwarding header is
 * never treated as local, so the bypass survives only for direct, un-proxied
 * hits from the owner's own browser.
 *
 * Exercised through the exported isAdmin(req), which is true iff the request is
 * a local bypass or an admin session.
 *
 * Run: node tests/test_admin_local_bypass.js   (no server required)
 */

const assert = require("assert");
const path = require("path");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const { isAdmin } = require(LIB + "/auth-middleware");

let passed = 0;
const say = (line) => process.stdout.write(line + "\n");
function ok(name) { passed++; say("  ✓ " + name); }

// Build a mock request. `headers` defaults to none (a direct, un-proxied hit).
function req({ headers = {}, ip = "127.0.0.1", port = 4177, session } = {}) {
  return { headers, socket: { remoteAddress: ip, localPort: port }, session };
}

const ADMIN_SESSION = { patreon: { id: "u1", role: "admin" } };

// The owner enables the loopback bypass on the machine the tunnel points at.
const PREV = process.env.LANTERN_LOCAL_ADMIN;
process.env.LANTERN_LOCAL_ADMIN = "1";

try {
  // --- Proxied/tunneled traffic must NEVER inherit the local bypass ---
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
      isAdmin(req({ headers: { [h]: "203.0.113.9" } })),
      false,
      `proxy header ${h} should deny the local bypass`
    );
    ok(`proxied request with ${h} → not admin`);
  }

  // A tunnel exposing the dev server (:4178) must not leak admin either.
  assert.strictEqual(
    isAdmin(req({ headers: { "cf-ray": "abc-ORD" }, port: 4178 })),
    false
  );
  ok("proxied request to dev port 4178 → not admin");

  // --- Legitimate local owner (direct hit, no proxy headers) still bypasses ---
  assert.strictEqual(isAdmin(req({ ip: "127.0.0.1", port: 4177 })), true);
  ok("direct loopback hit (LANTERN_LOCAL_ADMIN) → admin");

  assert.strictEqual(isAdmin(req({ ip: "::1", port: 4177 })), true);
  ok("direct IPv6 loopback hit → admin");

  assert.strictEqual(isAdmin(req({ port: 4178 })), true);
  ok("direct hit on dev server :4178 → admin");

  // --- Without the bypass, only a real admin session qualifies ---
  delete process.env.LANTERN_LOCAL_ADMIN;
  assert.strictEqual(isAdmin(req({ ip: "203.0.113.9", port: 443 })), false);
  ok("remote, no env, no session → not admin");

  assert.strictEqual(isAdmin(req({ ip: "203.0.113.9", port: 443, session: ADMIN_SESSION })), true);
  ok("real admin session → admin (independent of bypass)");

  // An admin session behind the proxy still works (header guard only gates the
  // loopback bypass, never a genuine authenticated session).
  assert.strictEqual(
    isAdmin(req({ headers: { "cf-connecting-ip": "203.0.113.9" }, session: ADMIN_SESSION })),
    true
  );
  ok("admin session behind proxy → admin");

  say(`\nAll ${passed} admin-local-bypass assertions passed.`);
} finally {
  if (PREV === undefined) delete process.env.LANTERN_LOCAL_ADMIN;
  else process.env.LANTERN_LOCAL_ADMIN = PREV;
}
