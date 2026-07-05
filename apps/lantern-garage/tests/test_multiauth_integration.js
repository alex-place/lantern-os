/**
 * ADR-0016 integration test — boots the REAL express-session + routes/auth.js +
 * routes/profiles.js over HTTP and drives them with a cookie-carrying client.
 *
 * Verifies end-to-end:
 *   - #1876: /api/profiles/me works for a non-Patreon (local) session (was 401).
 *   - #1877: /api/auth/:provider/start on an UNCONFIGURED provider redirects to
 *            /auth.html?error=provider_unconfigured instead of a raw 500.
 *   - local register → login → session → profile round-trip.
 *   - /api/auth/providers reflects configured providers only.
 *   - credential is never exposed by /api/profiles/me.
 *
 * Runs against a throwaway data dir; no external network. Node 18+ (global fetch).
 * Run: node apps/lantern-garage/tests/test_multiauth_integration.js
 */
"use strict";
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

// Isolate profile storage under a temp cwd BEFORE requiring the modules (they
// resolve data/profiles from process.cwd()).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "authtest-"));
process.chdir(tmp);
process.env.SESSION_SECRET = "integration-test-secret";
process.env.LANTERN_LOCAL_AUTH = "1";
// Configure exactly one OAuth provider (patreon) so we can assert the providers
// list, and leave google/discord UNCONFIGURED so /start must redirect gracefully.
process.env.PATREON_CLIENT_ID = "test-pat-id";
process.env.PATREON_CLIENT_SECRET = "test-pat-secret";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.DISCORD_CLIENT_ID;

const LIB = path.join(__dirname, "..");
const session = require(path.join(LIB, "node_modules/express-session"));
const authRoutes = require(path.join(LIB, "routes/auth.js"));
const profileRoutes = require(path.join(LIB, "routes/profiles.js"));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, sameSite: "lax", maxAge: 3600_000 },
});

const deps = {
  sendJson: (res, obj, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  },
};

const server = http.createServer((req, res) => {
  sessionMiddleware(req, res, async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const handler of [authRoutes, profileRoutes]) {
      const handled = await handler(req, res, url, deps);
      if (handled) return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  - " + n); } else { fail++; console.log("  FAIL- " + n); } };

// Minimal cookie jar so the session cookie survives across requests.
function makeClient(base) {
  let jar = "";
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      redirect: "manual",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(jar ? { Cookie: jar } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text, location: res.headers.get("location") };
  };
}

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = makeClient(base);
  try {
    // Anonymous: providers list = patreon (configured) + local; NOT google/discord.
    let r = await c("GET", "/api/auth/providers");
    const ids = (r.json.providers || []).map((p) => p.id);
    ok("providers lists configured patreon", ids.includes("patreon"));
    ok("providers lists local", ids.includes("local"));
    ok("providers omits unconfigured google", !ids.includes("google"));
    ok("providers omits unconfigured discord", !ids.includes("discord"));

    // #1877: unconfigured provider start → graceful redirect, not 500.
    r = await c("GET", "/api/auth/google/start?returnTo=/profile.html");
    ok("google/start redirects (302)", r.status === 302);
    ok("google/start redirects to /auth.html with error", /\/auth\.html\?/.test(r.location || "") && /provider_unconfigured/.test(r.location || ""));

    // Configured provider start → redirect to the provider (302), sets oauth cookie.
    r = await c("GET", "/api/auth/patreon/start?returnTo=/profile.html");
    ok("patreon/start redirects to patreon.com", r.status === 302 && /patreon\.com/.test(r.location || ""));

    // Anonymous profile is 401 (still gated).
    r = await c("GET", "/api/profiles/me");
    ok("anonymous /api/profiles/me is 401", r.status === 401);

    // Local register → hard email gate: account created, NO session, confirmation
    // pending (email delivery is "logged" here since no SMTP is configured).
    r = await c("POST", "/api/auth/local/register", { email: "dev@example.com", password: "supersecret", name: "Dev" });
    ok("local register 202 pending", r.status === 202 && r.json.ok === true && r.json.pendingVerification === true);
    ok("register does not establish a session", r.json.user === undefined);

    // Login is blocked until the email is confirmed.
    r = await c("POST", "/api/auth/local/login", { email: "dev@example.com", password: "supersecret" });
    ok("unverified login blocked 403", r.status === 403 && r.json.error === "email_unverified");

    // Confirm the email through the REAL verify-email route (mint the signed token
    // the confirmation link would carry).
    const { mintToken } = require(path.join(LIB, "lib/email-verification"));
    const { getProfileByEmail } = require(path.join(LIB, "lib/user-profiles"));
    const prof = getProfileByEmail("dev@example.com");
    const vtok = mintToken(prof.id, prof.email);
    r = await c("GET", "/api/auth/verify-email?token=" + encodeURIComponent(vtok));
    ok("verify-email redirects with success", r.status === 302 && /verify=success/.test(r.location || ""));
    r = await c("GET", "/api/auth/verify-email?token=tampered.sig");
    ok("verify-email rejects a bad token", r.status === 302 && /verify=invalid/.test(r.location || ""));

    // Now login succeeds and establishes a session.
    r = await c("POST", "/api/auth/local/login", { email: "dev@example.com", password: "supersecret" });
    ok("verified login 200", r.status === 200 && r.json.ok === true);

    // #1876: /api/profiles/me now works for a LOCAL (non-Patreon) session.
    r = await c("GET", "/api/profiles/me");
    ok("#1876 local session gets profile (not 401)", r.status === 200 && r.json && r.json.email === "dev@example.com");
    ok("profile.me strips credential", r.json.credential === undefined);
    ok("profile provider-agnostic id present", typeof r.json.id === "string" && r.json.id.length > 0);

    // Weak password rejected.
    r = await c("POST", "/api/auth/local/register", { email: "weak@example.com", password: "short" });
    ok("weak password rejected 400", r.status === 400 && r.json.error === "weak_password");

    // Logout clears session.
    r = await c("POST", "/api/auth/logout");
    ok("logout ok", r.status === 200);
    r = await c("GET", "/api/profiles/me");
    ok("after logout /api/profiles/me is 401 again", r.status === 401);

    // Fresh client: login with the registered account.
    const c2 = makeClient(base);
    r = await c2("POST", "/api/auth/local/login", { email: "dev@example.com", password: "supersecret" });
    ok("local login 200", r.status === 200 && r.json.ok === true);
    r = await c2("POST", "/api/auth/local/login", { email: "dev@example.com", password: "WRONG" });
    ok("wrong password 401", r.status === 401 && r.json.error === "invalid_credentials");

    // Session reports provider-agnostic identity.
    r = await c2("GET", "/api/auth/session");
    ok("session authenticated after login", r.json.authenticated === true);
    ok("session reports provider=local", r.json.provider === "local");
    ok("session advertises providers", Array.isArray(r.json.providers));
  } catch (e) {
    fail++;
    console.log("  FAIL- threw: " + e.stack);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
});
