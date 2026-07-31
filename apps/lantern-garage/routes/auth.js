/**
 * Auth routes (ADR-0016): provider-agnostic OAuth (Google), local
 * email+password, session, logout.
 *
 *   GET  /api/auth/session               → { authenticated, role, provider, entitlements, user, authRequired, providers }
 *   GET  /api/auth/providers             → { providers: [{ id, displayName }] }
 *   GET  /api/auth/:provider/start       → 302 to the provider (or /auth.html?error=… if unconfigured)
 *   GET  /api/auth/:provider/callback    → 302 back to returnTo on success
 *   POST /api/auth/local/register        → { ok, user }   (sets session)
 *   POST /api/auth/local/login           → { ok, user }   (sets session)
 *   POST /api/auth/logout                → { ok }
 */

const { getSessionInfo, handleLogout } = require("../lib/session-auth");
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
const { loginGateEnabled } = require("../lib/auth-middleware");
const { listEnabledProviders, getProvider } = require("../lib/auth-providers");
const { createToken, verifyToken, isConsumed, consumeToken } = require("../lib/auth-tokens");
const { destroyUserSessions } = require("../lib/session-file-store");
const _pathAuth = require("path");
// Session store dir (mirrors server.js) — a password reset invalidates the account's live
// sessions so a hijacked session can't survive the remediation (#2614).
const AUTH_SESSION_DIR = _pathAuth.join(__dirname, "..", "..", "..", "data", "sessions");
const { sendVerificationCodeEmail, sendPasswordResetEmail, mailerConfigured } = require("../lib/mailer");
const { issueCode, checkCode } = require("../lib/verify-codes");
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
    // frames leak (#2650). 'close' can fire before/instead of 'end' (over-cap destroy, or
    // undici's ordering), so it settles from whatever body arrived rather than clobbering a
    // good parse with null — the over-cap path already resolved(null) first. resolve() is
    // idempotent, so the races are harmless; the caller answers 413/400.
    req.on("data", (c) => { body += c; if (body.length > 1e6) { resolve(null); req.destroy(); } });
    const done = () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } };
    req.on("end", done);
    req.on("error", () => resolve(null));
    req.on("close", done);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Confirmation interstitial for a pending EMAIL CHANGE (#2646). Rendered inline by the
// verify-email route (NOT a new public .html surface), so an email prefetcher/scanner that
// auto-GETs the link gets a page but applies nothing — the change needs the explicit POST
// the button fires. `token` is a url-safe base64url.hmac string; the address is escaped.
function emailChangeInterstitial(token, newEmail) {
  const esc = (s) => String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Confirm email change</title><style>
body{font-family:system-ui,sans-serif;background:#0f151a;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
.card{max-width:420px;padding:28px 26px;border:1px solid #2a343d;border-radius:14px;background:#161d24;text-align:center}
h1{font-size:1.15rem;margin:0 0 10px}p{color:#9aa7b2;line-height:1.5;margin:0 0 18px}strong{color:#e6edf3}
button{font:inherit;padding:11px 18px;border-radius:9px;border:0;background:#3b82f6;color:#fff;cursor:pointer;width:100%}
button[disabled]{opacity:.6;cursor:progress}#s{margin:12px 0 0;font-size:14px;min-height:18px}
</style></head><body><div class="card">
<h1>Confirm your email change</h1>
<p>Confirm to change your account email to <strong>${esc(newEmail)}</strong>. This link only works once.</p>
<button id="c" type="button">Confirm email change</button>
<p id="s"></p>
<script>
document.getElementById('c').addEventListener('click',function(){this.disabled=true;
fetch('/api/auth/verify-email',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token || "")}})})
.then(function(r){return r.json().then(function(d){return{s:r.status,d:d};});})
.then(function(res){if(res.s===200){location.href=(res.d.dest||'/profile.html')+'?verify=1';}else{document.getElementById('c').disabled=false;document.getElementById('s').textContent='Could not confirm: '+((res.d&&res.d.error)||'please try the link again');}})
.catch(function(){document.getElementById('c').disabled=false;document.getElementById('s').textContent='Network error — try again.';});});
</script></div></body></html>`;
}

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

  // Per-request trace, opt-in (AUTH_DEBUG=1) — an unconditional console.log here
  // both spams prod logs and trips the SLOP debug-statement gate.
  if (process.env.AUTH_DEBUG === "1") console.error(`[AUTH] ${method} ${path}`);

  // GET /api/auth/session
  if (method === "GET" && path === "/api/auth/session") {
    const info = getSessionInfo(req);
    // Tell the client whether the login gate is active. When false, auth-gate.js
    // must not bounce guests to /auth.html.
    info.authRequired = loginGateEnabled();
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
  // set (google), without the OAuth round-trip.
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
  const startMatch = method === "GET" && path.match(START_RE);
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
  const cbMatch = method === "GET" && path.match(CALLBACK_RE);
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
  if (path === "/api/auth/verify-email" && (method === "GET" || method === "POST")) {
    const isPost = method === "POST";
    const token = isPost ? String(((await readJsonBody(req)) || {}).token || "") : url.searchParams.get("token");
    // Hard email gate: a fresh signup has no session, so land them on the login page; a
    // signed-in email change lands on profile.
    const dest = getSessionUser(req)?.id ? "/profile.html" : "/auth.html";
    // Uniform failure: POST callers (the confirm interstitial) get JSON; GET callers a banner.
    const fail = (reason, code) => {
      if (isPost) { res.writeHead(code || 400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: reason })); }
      res.writeHead(302, { Location: `${dest}?verify=${reason}` }); return res.end();
    };
    const payload = verifyToken(token, "verify_email");
    if (!payload) return fail("invalid");
    const profile = getProfile(payload.sub);
    if (!profile) return fail("invalid");
    // Single-use: a spent link (leaked, double-clicked, scanner re-fetch) lands on the
    // benign already-verified state rather than re-applying (#2614).
    if (isConsumed(payload.jti)) {
      if (isPost) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, already: true, dest })); }
      res.writeHead(302, { Location: `${dest}?verify=1` }); return res.end();
    }
    // The token carries the exact address it was minted for (#2624); an address that
    // differs from the profile's current one is a pending email CHANGE.
    const isEmailChange = !!(payload.email && payload.email !== profile.email);
    // #2646: an email CHANGE is a sensitive mutation and must NOT be applied by a GET that
    // a link-prefetcher/scanner auto-fetches. Serve a confirmation interstitial whose
    // button POSTs the token; only the POST applies. Plain signup verification stays a GET.
    if (isEmailChange && !isPost) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(emailChangeInterstitial(token, payload.email));
    }
    const updates = { emailVerified: true, emailAssumed: false, pendingEmail: null };
    if (isEmailChange) {
      // Apply ONLY when it matches the recorded pending change; otherwise it's a stale
      // signup/resend token from before the address changed and must not revert it (#2624).
      if (profile.pendingEmail && payload.email === profile.pendingEmail) {
        const clash = getProfileByEmail(payload.email);
        if (clash && clash.id !== profile.id) return fail("email_taken", 409);
        updates.email = payload.email;
        // Move the local login identity to the new address so the OLD email stops being a
        // working login key / email_taken squatter (#2625).
        updates.identities = (profile.identities || []).map((i) =>
          i.provider === "local" ? { ...i, email: payload.email } : i);
      } else {
        return fail("invalid");
      }
    }
    // Emit a verified `signup` traction event exactly once (OBSERVE stage). Guard on the
    // pre-update flag so repeat confirmations don't re-count. Best-effort.
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
      // First successful verification → welcome email (fire-and-forget). Guarded by
      // the same pre-update flag, so re-confirmations never re-send it.
      try { require("../lib/mailer").sendWelcomeEmail(updates.email || profile.email, profile.name).catch(() => {}); } catch (_e) { /* never block the verify */ }
    }
    if (isPost) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, dest })); }
    res.writeHead(302, { Location: `${dest}?verify=1` });
    return res.end();
  }

  // POST /api/auth/verify-code { email, code } — confirm a SIGNUP with the 6-digit
  // code from the email. The link route above still serves the email-CHANGE flow.
  //
  // Deliberately does NOT reveal whether the account exists: an unknown address and a
  // wrong code both return the same 400 invalid_code, so this can't be used to
  // enumerate registered emails (the same property the 202-on-existing-email signup
  // response protects, #2617).
  if (method === "POST" && path === "/api/auth/verify-code") {
    if (emailEndpointThrottled(req)) { res.writeHead(429, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "too_many_attempts" })); }
    const b = (await readJsonBody(req)) || {};
    const email = String(b.email || "").trim().toLowerCase();
    const code = String(b.code || "").trim();
    const bad = (reason, status) => {
      res.writeHead(status || 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: reason }));
    };
    if (!EMAIL_RE.test(email) || !/^\d+$/.test(code)) return bad("invalid_code");

    const profile = getProfileByEmail(email);
    if (!profile) return bad("invalid_code"); // same shape as a wrong code — no enumeration
    if (profile.emailVerified === true) {
      // Benign already-confirmed state; mirrors the link route's `already` response.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, already: true, dest: "/auth.html" }));
    }

    const result = await checkCode(profile.id, code);
    if (!result.ok) {
      // `locked` and `expired` are surfaced distinctly ONLY because the user already
      // proved they hold this address by having a code at all — and because "request a
      // new code" is otherwise undiscoverable. Neither reveals account existence, since
      // an unknown email never reaches this branch.
      if (result.reason === "locked") return bad("code_locked", 429);
      if (result.reason === "expired" || result.reason === "none") return bad("code_expired", 410);
      return bad("invalid_code");
    }

    const wasVerified = profile.emailVerified === true;
    updateProfile(profile.id, { emailVerified: true, emailAssumed: false });
    if (!wasVerified) {
      recordTractionEvent({
        kind: "signup",
        actor: profile.email || profile.id,
        verified: true,
        confidence: "high",
        source: `email_verified:${profile.id}`,
        note: "email address confirmed via verification code",
      }).catch(() => {});
      try { require("../lib/mailer").sendWelcomeEmail(profile.email, profile.name).catch(() => {}); } catch (_e) { /* never block the verify */ }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, dest: "/auth.html" }));
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
        // Issuing supersedes any outstanding code, which is the point of a resend:
        // it also clears a code that was locked out by wrong guesses.
        const code = await issueCode(profile.id, profile.email);
        sendVerificationCodeEmail(profile.email, profile.name, code).catch(() => {});
        // Dev-only self-service: no mail server + direct loopback hit → return the
        // code so the operator can confirm locally. Never on proxied/public traffic
        // or when a provider is configured (mirrors local-auth.devVerifyCode).
        if (!mailerConfigured() && isLoopback(req)) respBody.devVerifyCode = code;
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
    // Security notice to the account's address (fire-and-forget): the industry-
    // standard "if this wasn't you" alert after any password change.
    try { const pr = getProfile(payload.sub); if (pr && pr.email) require("../lib/mailer").sendPasswordChangedEmail(pr.email, pr.name).catch(() => {}); } catch (_e) { /* never block the reset */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  return false;
};

// Test seam (#2650): the body reader is otherwise module-private. Exposed so the
// route-body-robustness suite can drive the oversize/teardown paths directly.
module.exports.readJsonBody = readJsonBody;
