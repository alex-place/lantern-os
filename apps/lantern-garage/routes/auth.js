/**
 * Auth routes (ADR-0016): provider-agnostic OAuth (Google / Discord / Patreon),
 * local email+password, session, logout.
 *
 *   GET  /api/auth/session               → { authenticated, role, provider, entitlements, user, authRequired, providers }
 *   GET  /api/auth/providers             → { providers: [{ id, displayName }] }
 *   GET  /api/auth/:provider/start       → 302 to the provider (or /auth.html?error=… if unconfigured)
 *   GET  /api/auth/:provider/callback    → 302 back to returnTo on success
 *   POST /api/auth/local/register        → { ok, user }   (sets session)
 *   POST /api/auth/local/login           → { ok, user }   (sets session)
 *   POST /api/auth/logout                → { ok }
 */

const { getSessionInfo, handleLogout } = require("../lib/patreon-auth");
const { handleOAuthStart, handleOAuthCallback } = require("../lib/oauth-core");
const { getSessionUser, establishSession } = require("../lib/session-identity");
const {
  testAuthEnabled,
  ensureTestProfile,
  normalizeRole,
  isDirect: isDirectTestReq,
  TEST_ROLES,
} = require("../lib/test-auth");
const { handleLocalRegister, handleLocalLogin } = require("../lib/local-auth");
const { patreonAuthEnabled } = require("../lib/auth-middleware");
const { listEnabledProviders, getProvider } = require("../lib/auth-providers");
const { createToken, verifyToken } = require("../lib/auth-tokens");
const { sendVerificationEmail, sendPasswordResetEmail, smtpConfigured } = require("../lib/mailer");
const { isLoopback } = require("../lib/request-auth");
const { recordTractionEvent } = require("../lib/traction");
const {
  getProfile,
  getProfileByEmail,
  updateProfile,
  setLocalPassword,
} = require("../lib/user-profiles");

// Absolute origin of the current request (honors the tunnel's forwarded proto).
function originOf(req) {
  const host = (req.headers && req.headers.host) || "127.0.0.1";
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const START_RE = /^\/api\/auth\/([a-z]+)\/start$/;
const CALLBACK_RE = /^\/api\/auth\/([a-z]+)\/callback$/;

// Seed the test account up-front when test-auth is enabled, so the real
// /api/auth/local/login path and the role picker work immediately. No-op in prod.
if (testAuthEnabled()) {
  try { ensureTestProfile(); } catch (_) { /* seeding is best-effort */ }
}

module.exports = async function authRoutes(req, res, url, deps) {
  const path = url.pathname;
  const method = req.method;

  console.log(`[AUTH] ${method} ${path}`);

  // GET /api/auth/session
  if (method === "GET" && path === "/api/auth/session") {
    const info = getSessionInfo(req);
    // Tell the client whether the login gate is active. When false, auth-gate.js
    // must not bounce guests to /auth.html.
    info.authRequired = patreonAuthEnabled();
    // Advertise which login methods are actually usable (configured OAuth + local).
    info.providers = listEnabledProviders();
    // Test-auth: expose the role picker to the auth page ONLY on a direct, un-proxied
    // hit while the mechanism is enabled (never advertised on public/proxied traffic).
    if (testAuthEnabled() && isDirectTestReq(req)) {
      info.testMode = true;
      info.testRoles = TEST_ROLES;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(info));
  }

  // POST /api/auth/test-login { role, provider } — establish a cookie session as the
  // seeded test account with a chosen role (the browser role picker uses this). Gated
  // to a direct, un-proxied hit while LANTERN_TEST_AUTH_TOKEN is set; 404 otherwise so
  // the endpoint is invisible in production. Emulates an SSO login when `provider` is
  // set (google/discord/patreon), without the OAuth round-trip.
  if (method === "POST" && path === "/api/auth/test-login") {
    if (!testAuthEnabled() || !isDirectTestReq(req)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found" }));
    }
    const b = (await readJsonBody(req)) || {};
    const profile = ensureTestProfile();
    if (!profile) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "seed_failed" }));
    }
    const role = normalizeRole(b.role);
    const provider = String(b.provider || "local");
    establishSession(
      req,
      {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        emailVerified: true,
        role,
        tier: profile.tier || "dev",
        provider,
        entitlements: { trade: true },
        isTest: true,
      },
      (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "session_save_failed" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, role, provider }));
      }
    );
    return true;
  }

  // GET /api/auth/providers — configured login methods for the login page.
  if (method === "GET" && path === "/api/auth/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ providers: listEnabledProviders() }));
  }

  // POST /api/auth/local/register
  if (method === "POST" && path === "/api/auth/local/register") {
    await handleLocalRegister(req, res);
    return true;
  }

  // POST /api/auth/local/login
  if (method === "POST" && path === "/api/auth/local/login") {
    await handleLocalLogin(req, res);
    return true;
  }

  // GET /api/auth/:provider/start
  const startMatch = method === "GET" && START_RE.exec(path);
  if (startMatch) {
    const provider = startMatch[1];
    if (!getProvider(provider)) return false; // unknown → fall through to 404
    // Link mode: a signed-in user connecting another provider to THIS account
    // (?link=1). Only honored when there's an active session; the callback links
    // the identity and returns to the profile page.
    const linkMode = url.searchParams.get("link") === "1";
    const sessionUser = linkMode ? getSessionUser(req) : null;
    const linkTo = sessionUser && sessionUser.id ? sessionUser.id : null;
    const returnTo = linkTo ? "/profile.html" : url.searchParams.get("returnTo") || "/";
    handleOAuthStart(provider, req, res, returnTo, { linkTo });
    return true;
  }

  // GET /api/auth/:provider/callback
  const cbMatch = method === "GET" && CALLBACK_RE.exec(path);
  if (cbMatch) {
    const provider = cbMatch[1];
    if (!getProvider(provider)) return false;
    const query = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
    await handleOAuthCallback(provider, req, res, query);
    return true;
  }

  // POST /api/auth/logout
  if (method === "POST" && path === "/api/auth/logout") {
    handleLogout(req, res);
    return true;
  }

  // GET /api/auth/verify-email?token=… — confirm an email address (new account or
  // a pending email change). Applies the pending email if the token carries one.
  if (method === "GET" && path === "/api/auth/verify-email") {
    // Hard email gate: a fresh signup has no session, so land them on the login
    // page (where they now sign in). A signed-in email change lands on profile.
    const dest = getSessionUser(req)?.id ? "/profile.html" : "/auth.html";
    const payload = verifyToken(url.searchParams.get("token"), "verify_email");
    if (!payload) {
      res.writeHead(302, { Location: `${dest}?verify=invalid` });
      return res.end();
    }
    const profile = getProfile(payload.sub);
    if (!profile) {
      res.writeHead(302, { Location: `${dest}?verify=invalid` });
      return res.end();
    }
    const updates = { emailVerified: true, pendingEmail: null };
    // If the token was minted for a pending email change, apply it now (unless
    // someone else claimed that email in the meantime).
    if (payload.email && payload.email !== profile.email) {
      const clash = getProfileByEmail(payload.email);
      if (clash && clash.id !== profile.id) {
        res.writeHead(302, { Location: `${dest}?verify=email_taken` });
        return res.end();
      }
      updates.email = payload.email;
    }
    // Emit a verified `signup` traction event exactly once — email confirmation is
    // the moment a local signup clears the hard email gate (OBSERVE stage). Guard on
    // the pre-update flag so repeat clicks on the same link don't re-count. The
    // ledger's classifyActor() files the operator's own confirmations as "operator",
    // so this never inflates external adoption. Best-effort; never blocks the redirect.
    const wasVerified = profile.emailVerified === true;
    updateProfile(profile.id, updates);
    if (!wasVerified) {
      recordTractionEvent({
        kind: "signup",
        actor: updates.email || profile.email || profile.id,
        verified: true,
        confidence: "high",
        source: `email_verified:${profile.id}`,
        note: "email address confirmed via verify-email link",
      }).catch(() => {});
    }
    res.writeHead(302, { Location: `${dest}?verify=1` });
    return res.end();
  }

  // POST /api/auth/resend-verification { email } — re-send the signup confirmation
  // link. Always 200 (no account enumeration); sends only for an existing account
  // whose email is still unconfirmed.
  if (method === "POST" && path === "/api/auth/resend-verification") {
    const b = await readJsonBody(req);
    const email = String((b && b.email) || "").trim().toLowerCase();
    const respBody = { ok: true };
    if (EMAIL_RE.test(email)) {
      const profile = getProfileByEmail(email);
      if (profile && profile.emailVerified !== true) {
        const token = createToken("verify_email", profile.id, null);
        const link = `${originOf(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
        sendVerificationEmail(profile.email, profile.name, link).catch(() => {});
        // Dev-only self-service: no mail server + direct loopback hit → return the
        // link so the operator can confirm locally. Never on proxied/public traffic
        // or when SMTP is configured (mirrors local-auth.devVerifyLink).
        if (!smtpConfigured() && isLoopback(req)) respBody.devVerifyLink = link;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(respBody));
  }

  // POST /api/auth/request-password-reset { email } — always 200 (no account
  // enumeration); sends a reset link only if a local-capable account exists.
  if (method === "POST" && path === "/api/auth/request-password-reset") {
    const b = await readJsonBody(req);
    const email = String((b && b.email) || "").trim().toLowerCase();
    if (EMAIL_RE.test(email)) {
      const profile = getProfileByEmail(email);
      if (profile) {
        const token = createToken("reset_password", profile.id, profile.email);
        const link = `${originOf(req)}/reset-password.html?token=${encodeURIComponent(token)}`;
        sendPasswordResetEmail(profile.email, profile.name, link).catch(() => {});
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // POST /api/auth/reset-password { token, newPassword }
  if (method === "POST" && path === "/api/auth/reset-password") {
    const b = await readJsonBody(req);
    if (!b) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_json" })); }
    const payload = verifyToken(b.token, "reset_password");
    if (!payload) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_or_expired" })); }
    const newPassword = String(b.newPassword || "");
    if (newPassword.length < MIN_PASSWORD) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "weak_password", detail: `min ${MIN_PASSWORD} chars` }));
    }
    if (!getProfile(payload.sub)) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "unknown_account" })); }
    setLocalPassword(payload.sub, newPassword);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  return false;
};
