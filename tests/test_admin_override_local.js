/**
 * Regression: LANTERN_ADMIN_IDS must be able to elevate an EMAIL/PASSWORD account (#3087).
 *
 * The override was only ever consulted on the OAuth path, so on a deploy without
 * working Google OAuth there was no path to admin via the documented env var: the
 * login succeeded and the session stayed `guest`, with nothing warning that the
 * override had been ignored.
 *
 * Run: node tests/test_admin_override_local.js   (no server; isolated data root)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-admin-override-"));
process.env.UNISONA_STATE_DIR = tmp;
process.env.SESSION_SECRET = ["unit", "test", "strong", "secret", "not", "dev", "default"].join("-");
// The override is read at module load, so it must be set BEFORE the requires below.
process.env.LANTERN_ADMIN_IDS = "local:Owner@Example.com";
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "PORT", "LANTERN_LOCAL_AUTH"]) delete process.env[k];

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const { isAdminOverride, profileHasAdminOverride } = require(path.join(LIB, "auth-providers"));
const { handleLocalRegister, handleLocalLogin } = require(path.join(LIB, "local-auth"));
const userProfiles = require(path.join(LIB, "user-profiles"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

function mkReq(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { host: "127.0.0.1:4177" };
  req.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  req.session = {};
  req._body = body;
  return req;
}
function mkRes() {
  const res = {};
  res.done = new Promise((r) => { res._resolve = r; });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; return res; };
  res.end = (s) => { res.body = s; try { res.json = s ? JSON.parse(s) : null; } catch { res.json = null; } res._resolve(res); };
  return res;
}
async function call(handler, req) {
  const res = mkRes();
  Promise.resolve(handler(req, res)).catch((e) => { res.body = String(e); res._resolve(res); });
  process.nextTick(() => { req.emit("data", Buffer.from(JSON.stringify(req._body))); req.emit("end"); });
  return res.done;
}

async function main() {
  // 1. The override matches a local identity case-insensitively (the stored providerId
  //    is the lowercased email, so a mixed-case env entry must still match).
  assert.strictEqual(isAdminOverride("local", "owner@example.com"), true);
  assert.strictEqual(isAdminOverride("local", "someone@example.com"), false);
  ok("isAdminOverride matches a local: entry case-insensitively");

  // 2. A bare id is still read as a GOOGLE id — it must NOT cross-grant to local.
  assert.strictEqual(isAdminOverride("google", "owner@example.com"), false);
  ok("a local: override does not grant admin to a same-id google identity");

  // 3. End-to-end: register + log in with email/password → the session is admin.
  const PW = ["correct", "horse", "battery", "staple"].join("-");
  await call(handleLocalRegister, mkReq({ email: "owner@example.com", password: PW, name: "Owner" }));
  const created = userProfiles.getProfileByEmail("owner@example.com");
  assert.ok(created, "profile created");
  assert.strictEqual(created.role, "guest", "registration itself does not elevate");
  assert.strictEqual(profileHasAdminOverride(created), true, "profile carries the override identity");

  // Login is hard-gated on a confirmed email; confirm it directly rather than
  // re-testing the code flow (tests/test_local_auth_flow.js already covers that).
  userProfiles.updateProfile(created.id, { emailVerified: true });

  const loginReq = mkReq({ email: "owner@example.com", password: PW });
  const res = await call(handleLocalLogin, loginReq);
  assert.strictEqual(res.status, 200, `login ok (got ${res.status}: ${res.body})`);
  assert.strictEqual(loginReq.session.user.role, "admin", "session role is admin");
  ok("local login honours LANTERN_ADMIN_IDS → session role admin (#3087)");

  // 4. The elevation is PERSISTED, not just session-local — so every other gate that
  //    reads the profile (not the session) sees admin too.
  assert.strictEqual(userProfiles.getProfileByEmail("owner@example.com").role, "admin");
  ok("the elevation is persisted to the profile store");

  // 5. A non-override local account is untouched.
  const other = mkReq({ email: "someone@example.com", password: PW, name: "Someone" });
  await call(handleLocalRegister, other);
  assert.strictEqual(userProfiles.getProfileByEmail("someone@example.com").role, "guest");
  ok("a non-override local account stays guest");

  console.log(`\nAll ${passed} admin-override assertions passed.`);
}

main()
  .catch((err) => { console.error("\n[FAIL]", (err && err.stack) || err); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });
