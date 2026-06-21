/**
 * test_patreon_auth_flag.js — the `patreon_auth` feature flag gates the Patreon
 * login redirect, WITHOUT exposing privileged surfaces when it's off.
 *
 * Matrix (for a non-local, unauthenticated request):
 *   gate ON  (default / flag absent) → requireAuth/Role/Entitlement redirect 302 → /auth.html
 *   gate OFF (flag created+disabled)  → requireAuth ok; requireRole("guest") ok;
 *                                       requireRole("admin") 403; requireEntitlement 403
 *   local bypass (dev port 4178)      → always allowed, regardless of the flag
 *
 * Run: node tests/test_patreon_auth_flag.js
 */
"use strict";

const fs = require("fs");
const assert = require("assert");
const ff = require("../apps/lantern-garage/lib/feature-flags");
const auth = require("../apps/lantern-garage/lib/auth-middleware");

// Back up the real flag store so the test leaves the worktree untouched.
const STORE = ff.STORE_PATH;
const hadStore = fs.existsSync(STORE);
const backup = hadStore ? fs.readFileSync(STORE, "utf-8") : null;

function restore() {
  try {
    if (hadStore) fs.writeFileSync(STORE, backup);
    else if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  } catch (_e) {}
  ff._resetCache();
}

// A request that is NOT the local-admin bypass: real (non-4178) port, no proxy
// headers, no LANTERN_LOCAL_ADMIN, and no Patreon session.
function guestReq() {
  return { headers: {}, socket: { localPort: 4177, remoteAddress: "203.0.113.7" }, session: undefined };
}
// The dev-server local bypass (port 4178 → admin).
function localReq() {
  return { headers: {}, socket: { localPort: 4178, remoteAddress: "127.0.0.1" }, session: undefined };
}
// Capture what a guard writes to the response.
function mockRes() {
  return {
    statusCode: null, headers: null, body: "", ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(b) { if (b) this.body += b; this.ended = true; },
  };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
}

try {
  delete process.env.LANTERN_LOCAL_ADMIN;

  // ── Gate ON (flag absent → default on) ────────────────────────────────────
  ff.deleteFlag("patreon_auth"); ff._resetCache();
  assert.strictEqual(auth.patreonAuthEnabled(), true, "absent flag defaults ON");

  check("gate ON: requireAuth redirects guest to /auth.html", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireAuth(guestReq(), res), false);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, "/auth.html");
  });
  check("gate ON: requireEntitlement(trade) redirects guest", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireEntitlement(guestReq(), res, "trade"), false);
    assert.strictEqual(res.statusCode, 302);
  });

  // ── Gate OFF (flag created + disabled) ────────────────────────────────────
  ff.setFlag("patreon_auth", { enabled: false }); ff._resetCache();
  assert.strictEqual(auth.patreonAuthEnabled(), false, "disabled flag → gate off");

  check("gate OFF: requireAuth allows guest (no redirect)", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireAuth(guestReq(), res), true);
    assert.strictEqual(res.ended, false);
  });
  check("gate OFF: requireRole('guest') allows guest", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireRole(guestReq(), res, "guest"), true);
  });
  check("gate OFF: requireRole('admin') is REFUSED with 403 (not exposed)", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireRole(guestReq(), res, "admin"), false);
    assert.strictEqual(res.statusCode, 403);
  });
  check("gate OFF: requireEntitlement('trade') is REFUSED with 403 (not exposed)", () => {
    const res = mockRes();
    assert.strictEqual(auth.requireEntitlement(guestReq(), res, "trade"), false);
    assert.strictEqual(res.statusCode, 403);
  });
  check("gate OFF: requireRole('admin') never 302s to a dead login", () => {
    const res = mockRes();
    auth.requireRole(guestReq(), res, "admin");
    assert.notStrictEqual(res.statusCode, 302);
  });

  // ── Local bypass beats the flag in both directions ────────────────────────
  check("local bypass (4178): admin allowed even with gate OFF", () => {
    assert.strictEqual(auth.requireRole(localReq(), mockRes(), "admin"), true);
    assert.strictEqual(auth.requireEntitlement(localReq(), mockRes(), "trade"), true);
  });
  ff.deleteFlag("patreon_auth"); ff._resetCache(); // back to gate ON
  check("local bypass (4178): allowed with gate ON too", () => {
    assert.strictEqual(auth.requireAuth(localReq(), mockRes()), true);
  });
} finally {
  restore();
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall patreon_auth flag checks passed");
