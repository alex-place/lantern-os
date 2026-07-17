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
const { createToken, verifyToken, isConsumed, consumeToken } = require("../lib/auth-tokens");
const { destroyUserSessions } = require("../lib/session-file-store");
const _pathAuth = require("path");
// Session store dir (mirrors server.js) — a password reset invalidates the account's live
// sessions so a hijacked session can't survive the remediation (#2614).
const AUTH_SESSION_DIR = _pathAuth.join(__dirname, "..", "..", "..", "data", "sessions");
const { sendVerificationEmail, sendPasswordResetEmail, smtpConfigured } = require("../lib/mailer");
const { isLoopback, clientIp } = require("../lib/request-auth");
const { canonicalOrigin } = require("../lib/base-url");

// Lightweight per-IP limiter for the UNAUTHENTICATED email endpoints (password
// reset, resend verification) so they can't be used to email-bomb a victim or scan
// (#2615). Best-effort in-memory; keyed on the real client IP (#2616).
const _emailHits = new Map();
function emailEndpointThrottled(req, max = 12, windowMs = 15 * 60 * 1000) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = _emailHits.get(ip);
  if (!rec || now - rec.first > windowMs) { _emailHits.set(ip, { count: 1, first: now }); return false; }
  rec.count++;
  if (_emailHits.size > 5000) { for (const [k, v] of _emailHits) if (now - v.first > windowMs) _emailHits.delete(k); }
  return rec.count > max;
}
const { recordTractionEvent } = require("../lib/traction");
const {
  getProfile,
  getProfileByEmail,
  updateProfile,
  setLocalPassword,
} = require("../lib/user-profiles");

// Absolute origin for links emailed to the user (verify-email, password reset).
// Built from the operator-configured canonical origin, NOT the raw Host header, so
// a forged Host can't point a genuine security email at an attacker's domain
// (reset poisoning, #2604). Falls back to Host only for loopback dev.
function originOf(req) {
  return canonicalOrigin(req);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    // Over the 1MB cap: settle (null) BEFORE destroying — req.destroy() fires neither
    // 'end' nor 'error', so otherwise the awaiting auth handler never responds and its
    // frames leak (#2650). Mirrors the billing raw-body reader. resolve() is idempotent.
    req.on("data", (c) => { body += c; if (body.length > 1e6) { resolve(null); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null));
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
    // Single-use: once this link has applied its change, a replay (leaked link, a second
    // click, a link-scanner re-fetch) must not run again — land on the benign
    // already-verified state rather than re-applying (#2614).
    if (isConsumed(payload.jti)) {
      res.writeHead(302, { Location: `${dest}?verify=1` });
      return res.end();
    }
    const updates = { emailVerified: true, emailAssumed: false, pendingEmail: null };
    // The token now carries the exact address it was minted for (#2624), so a stale
    // link can't silently verify a DIFFERENT current address.
    if (payload.email && payload.email !== profile.email) {
      // Token address differs from the profile's current one. Apply it ONLY when it
      // matches a pending email CHANGE (change-email minted it for that new address);
      // otherwise it's a stale signup/resend token from before the address changed and
      // must not revert the email (#2624).
      if (profile.pendingEmail && payload.email === profile.pendingEmail) {
        const clash = getProfileByEmail(payload.email);
        if (clash && clash.id !== profile.id) {
          res.writeHead(302, { Location: `${dest}?verify=email_taken` });
          return res.end();
        }
        updates.email = payload.email;
        // Move the local login identity to the new address so the OLD email stops being
        // a working login key / email_taken squatter (#2625).
        updates.identities = (profile.identities || []).map((i) =>
          i.provider === "local" ? { ...i, email: payload.email } : i);
      } else {
        res.writeHead(302, { Location: `${dest}?verify=invalid` });
        return res.end();
      }
    }
    // Emit a verified `signup` traction event exactly once — email confirmation is
    // the moment a local signup clears the hard email gate (OBSERVE stage). Guard on
    // the pre-update flag so repeat clicks on the same link don't re-count. The
    // ledger's classifyActor() files the operator's own confirmations as "operator",
    // so this never inflates external adoption. Best-effort; never blocks the redirect.
    const wasVerified = profile.emailVerified === true;
    updateProfile(profile.id, updates);
    consumeToken(payload.jti, payload.exp); // burn the link so it can't be replayed (#2614)
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
    if (emailEndpointThrottled(req)) { res.writeHead(429, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true })); }
    const b = await readJsonBody(req);
    const email = String((b && b.email) || "").trim().toLowerCase();
    const respBody = { ok: true };
    if (EMAIL_RE.test(email)) {
      const profile = getProfileByEmail(email);
      if (profile && profile.emailVerified !== true) {
        const token = createToken("verify_email", profile.id, profile.email);
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
    if (emailEndpointThrottled(req)) { res.writeHead(429, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true })); }
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
    // Reject a replayed link: a reset token is single-use, so once spent it can't reset
    // the password again for the rest of its TTL even if leaked (#2614).
    if (!payload || isConsumed(payload.jti)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_or_expired" })); }
    const newPassword = String(b.newPassword || "");
    if (newPassword.length < MIN_PASSWORD) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "weak_password", detail: `min ${MIN_PASSWORD} chars` }));
    }
    if (!getProfile(payload.sub)) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "unknown_account" })); }
    setLocalPassword(payload.sub, newPassword);
    consumeToken(payload.jti, payload.exp);              // burn the token — no replay
    destroyUserSessions(AUTH_SESSION_DIR, payload.sub);  // sign out any hijacked session
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  return false;
};
