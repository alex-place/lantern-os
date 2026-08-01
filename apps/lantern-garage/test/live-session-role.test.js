// #2627 / #2605 — access decisions must re-derive the role from the PERSISTED
// profile on each request, NOT the role snapshotted into the cookie at login. So a
// demoted admin / downgraded tier loses access on the very NEXT request, without
// waiting for the (disk-persisted) session to end.
//
// This pins the WHOLE gate family — requireRole, isStaff, isAdmin, AND requireStaff.
// requireStaff was the lone gate still trusting `session.role` (exported-but-unwired,
// so latent) until it was switched to effectiveRole; this guards against regression
// and against a future route adopting it and silently reintroducing the hole.
//
// Run: node apps/lantern-garage/test/live-session-role.test.js  (isolates to a temp cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-liverole-"));
process.chdir(_tmpRoot);
process.env.UNISONA_STATE_DIR = _tmpRoot; // #3088: user-profiles roots at dataRoot(), not cwd
process.env.SESSION_SECRET = ["unit", "test", "strong", "secret", "value"].join("-");

const profiles = require(path.join(__dirname, "..", "lib", "user-profiles"));
const {
  requireStaff, isStaff, isAdmin, requireRole,
} = require(path.join(__dirname, "..", "lib", "auth-middleware"));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write("  ok  - " + name + "\n"); }
  catch (e) { failures++; process.stdout.write("  FAIL- " + name + "\n        " + e.message + "\n"); }
}

// res double: captures the terminal status; gates return a boolean AND may writeHead/end.
function mkRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (s) => { res.status = s; return res; };
  res.end = (b) => { res.body = b || ""; return res; };
  return res;
}
// A signed-in request whose COOKIE still says admin (the stale snapshot).
function reqFor(id) {
  return { method: "GET", url: "/accounts.html", headers: { host: "127.0.0.1:4177" }, session: { user: { id, role: "admin" } } };
}

// Seed a real admin profile and point a stale-admin cookie at it.
const prof = profiles.createProfile("u-staff-1", { email: "staff@x.local", role: "admin", emailVerified: true });
const req = reqFor(prof.id);

// ── While the profile IS admin, every gate allows ────────────────────────────
check("admin profile: isAdmin true", () => assert.strictEqual(isAdmin(req), true));
check("admin profile: isStaff true", () => assert.strictEqual(isStaff(req), true));
check("admin profile: requireStaff allows", () => assert.strictEqual(requireStaff(req, mkRes()), true));
check("admin profile: requireRole('admin') allows", () => assert.strictEqual(requireRole(req, mkRes(), "admin"), true));

// ── Demote the PROFILE to a non-staff role. The COOKIE is untouched (still admin). ──
assert.strictEqual(profiles.updateProfile(prof.id, { role: "supporter" }).role, "supporter");

check("after demotion, cookie still says admin (proves we're testing the stale snapshot)",
  () => assert.strictEqual(req.session.user.role, "admin"));
check("demoted: isAdmin now FALSE (re-derives from profile)", () => assert.strictEqual(isAdmin(req), false));
check("demoted: isStaff now FALSE", () => assert.strictEqual(isStaff(req), false));
check("demoted: requireStaff now DENIES 403 (#2627 — the gate that was still trusting session.role)", () => {
  const res = mkRes();
  assert.strictEqual(requireStaff(req, res), false);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(JSON.parse(res.body).current, "supporter"); // reports the LIVE role, not the cookie's admin
});
check("demoted: requireRole('admin') now DENIES 403", () => {
  const res = mkRes();
  assert.strictEqual(requireRole(req, res, "admin"), false);
  assert.strictEqual(res.status, 403);
});
// A supporter-level gate the demoted user still legitimately clears (sanity: not over-denying).
check("demoted user still clears requireRole('supporter')", () =>
  assert.strictEqual(requireRole(req, mkRes(), "supporter"), true));

process.stdout.write("\n" + (failures ? failures + " FAILED\n" : "all live-session-role checks passed\n"));
process.exit(failures ? 1 : 0);
