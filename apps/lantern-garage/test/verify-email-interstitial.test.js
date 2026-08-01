// A pending EMAIL CHANGE must NOT be applied by the GET that a link-prefetcher/scanner
// auto-fetches (#2646): the GET serves a confirmation interstitial and mutates nothing;
// only an explicit POST applies it; the token is single-use (#2614). In-process (calls the
// route handler directly) so the token secret matches without cross-process env plumbing.
//
// Run: node apps/lantern-garage/test/verify-email-interstitial.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

// Isolate the profile + token-ledger stores to a temp cwd BEFORE requiring the app.
const _tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-int-"));
process.chdir(_tmpDataRoot);
// The data root is module-anchored, not cwd-derived (#3088) — isolate the store via
// UNISONA_STATE_DIR so this test never writes into the real repo data/ tree.
process.env.UNISONA_STATE_DIR = _tmpDataRoot;
const profiles = require("../lib/user-profiles");
const { createToken } = require("../lib/auth-tokens");
const authRoutes = require("../routes/auth");

let failures = 0;
function check(name, cond, detail) { if (cond) console.error("  ok  -", name); else { failures++; console.error("  FAIL-", name, "\n      ", detail || ""); } }

const uid = "u-verify-1";
profiles.createProfile(uid, {
  email: "old@example.com", emailVerified: true,
  identities: [{ provider: "local", providerId: uid, email: "old@example.com", emailVerified: true }],
});
// createProfile doesn't carry pendingEmail; set it the way the change-email endpoint does.
profiles.updateProfile(uid, { pendingEmail: "new@example.com" });
const emailOf = () => profiles.getProfile(uid).email;

// Minimal req/res doubles. req is a Readable that pushes the body only once a consumer
// (readJsonBody) starts reading — otherwise the buffered data can 'end' before the handler
// attaches its listeners, and it'd never see the body.
function makeReq(method, bodyObj) {
  const bodyStr = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  let sent = false;
  const req = new Readable({ read() { if (sent) return; sent = true; if (bodyStr !== undefined) this.push(bodyStr); this.push(null); } });
  req.method = method; req.headers = { host: "127.0.0.1:4177" }; req.session = {}; req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}
function makeRes() {
  return { statusCode: 0, headers: {}, body: "", _ended: false,
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this; },
    end(b) { this.body = b == null ? "" : String(b); this._ended = true; return this; } };
}
async function call(method, token, bodyObj) {
  const url = new URL(`http://127.0.0.1:4177/api/auth/verify-email${method === "GET" ? "?token=" + encodeURIComponent(token) : ""}`);
  const req = makeReq(method, method === "POST" ? (bodyObj || { token }) : undefined);
  const res = makeRes();
  await authRoutes(req, res, url, {});
  return res;
}

(async () => {
  const token = createToken("verify_email", uid, "new@example.com");

  // 1. GET → confirmation interstitial (200 HTML), NOTHING applied.
  let r = await call("GET", token);
  check("GET email-change link → confirm interstitial (200 HTML)", r.statusCode === 200 && /Confirm your email change/i.test(r.body), "status " + r.statusCode);
  check("GET applied nothing (email still old)", emailOf() === "old@example.com", "email=" + emailOf());

  // 2. A prefetcher hitting it again still changes nothing.
  await call("GET", token);
  check("repeat GET still applies nothing", emailOf() === "old@example.com", "email=" + emailOf());

  // 3. POST confirms → applied.
  r = await call("POST", token);
  let body = {}; try { body = JSON.parse(r.body); } catch { /* */ }
  check("POST applies the change (200 ok)", r.statusCode === 200 && body.ok === true, "status " + r.statusCode + " body " + r.body);
  check("email is now the new address", emailOf() === "new@example.com", "email=" + emailOf());

  // 4. Single-use: replaying the consumed token is a benign no-op.
  r = await call("POST", token);
  try { body = JSON.parse(r.body); } catch { body = {}; }
  check("consumed token replay → already:true", r.statusCode === 200 && body.already === true, r.body);

  // 5. A plain signup verification (no email change) still applies on the GET.
  const u2 = "u-verify-2";
  profiles.createProfile(u2, { email: "fresh@example.com", emailVerified: false, identities: [{ provider: "local", providerId: u2, email: "fresh@example.com" }] });
  const t2 = createToken("verify_email", u2, "fresh@example.com");
  r = await call("GET", t2);
  check("plain signup-verify still applies on GET (302 verify=1)", r.statusCode === 302 && /verify=1/.test(r.headers.Location || ""), "status " + r.statusCode + " loc " + (r.headers.Location || ""));
  check("plain signup marked verified", profiles.getProfile(u2).emailVerified === true, "verified=" + profiles.getProfile(u2).emailVerified);

  console.error(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
