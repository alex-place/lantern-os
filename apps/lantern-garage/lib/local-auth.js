/**
 * Local email + password auth handlers (ADR-0016).
 *
 * Self-contained, offline, zero external deps — password hashing is Node's built-in
 * scrypt (see user-profiles.hashPassword). Unlike the OAuth flows (which redirect
 * server-side), these are fetch()-friendly JSON endpoints the login page calls and
 * then navigates on success.
 *
 * Includes a light in-memory throttle to blunt online password guessing. It is
 * best-effort (per-process) — a production deployment behind multiple workers
 * should front this with a shared store; noted in ADR-0016 follow-ups.
 */

const {
  createLocalAccount,
  verifyLocalLoginAsync,
  publicProfile,
  updateProfile,
} = require("./user-profiles");
const { establishSession } = require("./session-identity");
const { createToken } = require("./auth-tokens");
const { sendVerificationEmail, smtpConfigured } = require("./mailer");
const { isLoopback } = require("./request-auth");
const { canonicalOrigin } = require("./base-url");
const { TEST_ID, testAuthEnabled, isDirect: testIsDirect } = require("./test-auth");

/** Build a fresh email-confirmation link (mints a verify_email token). Uses the
 *  canonical origin, NOT the spoofable Host header, so a forged Host can't point
 *  a genuine confirmation email at an attacker's domain (#2604). */
function verifyLinkFor(req, profile) {
  const token = createToken("verify_email", profile.id, null);
  return `${canonicalOrigin(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

// Fire-and-forget: email the new account a confirmation link (dev fallback logs
// it). Never blocks or fails registration. Returns { delivery, link } where
// delivery is "sent" (SMTP configured) or "logged" (link only went to the server
// log/outbox). The link is returned so a loopback dev caller can complete the
// flow without a mail server (see devVerifyLink below).
function sendSignupVerification(req, profile) {
  try {
    const link = verifyLinkFor(req, profile);
    sendVerificationEmail(profile.email, profile.name, link).catch(() => {});
    return { delivery: smtpConfigured() ? "sent" : "logged", link };
  } catch (_) {
    return { delivery: "logged", link: null }; // best-effort
  }
}

// Dev-only self-service: when NO mail server is configured AND the request is a
// direct, un-proxied loopback hit (the operator's own machine), it is safe to
// hand the confirmation link straight back so local testing can complete the
// email-gate flow. Proxied/public traffic and any SMTP-configured deployment
// NEVER receive it — the link only ever surfaces where it already goes to the
// local server log.
function devVerifyLink(req, profile) {
  if (smtpConfigured() || !isLoopback(req)) return null;
  return verifyLinkFor(req, profile);
}

// One-time operator warning: on a mailer-less deploy we admit local signups
// WITHOUT email verification (see #2065). Email-ownership is therefore unproven —
// configure SMTP to restore the confirmation gate.
let _warnedNoMailerAdmit = false;
function warnNoMailerAdmit() {
  if (_warnedNoMailerAdmit) return;
  _warnedNoMailerAdmit = true;
  console.warn(
    "[auth] SMTP is not configured — admitting local signups without email verification " +
    "(#2065). Set SMTP_* to require confirmed emails."
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// ── best-effort brute-force throttle ────────────────────────────────────────────
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000; // 15 min rolling window
const attempts = new Map(); // key -> { count, first }

function _key(req, email) {
  const ip = (req.socket && req.socket.remoteAddress) || "?";
  return `${ip}:${String(email || "").toLowerCase()}`;
}
function throttled(req, email) {
  const k = _key(req, email);
  const rec = attempts.get(k);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(k);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailure(req, email) {
  const k = _key(req, email);
  const rec = attempts.get(k);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(k, { count: 1, first: Date.now() });
  else rec.count++;
}
function clearFailures(req, email) {
  attempts.delete(_key(req, email));
}

// Per-IP request budget, INDEPENDENT of email — the email-keyed throttle above is
// trivially bypassed by varying the email, so one IP could still force unbounded
// scrypt+profile-scan work and grow the map forever (#2609). Cap total auth writes
// per IP per window and sweep both maps so neither grows without bound.
const IP_MAX = 40;
const ipAttempts = new Map(); // ip -> { count, first }
function _ip(req) { return (req && req.socket && req.socket.remoteAddress) || "?"; }
function ipBudgetExceeded(req) {
  const ip = _ip(req);
  const rec = ipAttempts.get(ip);
  const now = Date.now();
  if (!rec || now - rec.first > WINDOW_MS) { ipAttempts.set(ip, { count: 1, first: now }); return false; }
  rec.count++;
  return rec.count > IP_MAX;
}
const _sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of attempts) if (now - rec.first > WINDOW_MS) attempts.delete(k);
  for (const [k, rec] of ipAttempts) if (now - rec.first > WINDOW_MS) ipAttempts.delete(k);
}, WINDOW_MS);
if (_sweep.unref) _sweep.unref(); // never keep the process alive for the sweep

function _readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
const { SIGNOUT_COOKIE } = require("./auth-middleware");

function _json(res, status, obj) {
  // Clear the explicit-signout marker on any successful auth response so the
  // local/dev bypass is restored after the user logs back in (#auth-signout).
  const headers = { "Content-Type": "application/json" };
  if (status >= 200 && status < 300) {
    headers["Set-Cookie"] = `${SIGNOUT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}
function _establish(req, res, profile, status) {
  establishSession(
    req,
    {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      emailVerified: profile.emailVerified === true,
      role: profile.role,
      tier: profile.tier,
      provider: "local",
    },
    (err) => {
      if (err) return _json(res, 500, { error: "session_save_failed" });
      _json(res, status, { ok: true, user: publicProfile(profile) });
    }
  );
}

/** POST /api/auth/local/register { email, password, name } */
async function handleLocalRegister(req, res) {
  if (process.env.LANTERN_LOCAL_AUTH === "0") return _json(res, 403, { error: "local_auth_disabled" });
  if (ipBudgetExceeded(req)) return _json(res, 429, { error: "too_many_attempts", detail: "try again later" }); // register also runs scrypt (#2609)
  const b = await _readJson(req);
  if (!b) return _json(res, 400, { error: "invalid_json" });
  const email = String(b.email || "").trim();
  const password = String(b.password || "");
  const name = String(b.name || "").trim().slice(0, 120);
  if (!EMAIL_RE.test(email)) return _json(res, 400, { error: "invalid_email" });
  if (password.length < MIN_PASSWORD) return _json(res, 400, { error: "weak_password", detail: `min ${MIN_PASSWORD} chars` });

  const result = createLocalAccount(email, password, name);
  if (result.error === "email_taken") return _json(res, 409, { error: "email_taken" });
  if (!result.profile) return _json(res, 500, { error: "create_failed" });

  // No-mailer lockout guard (#2065): with SMTP unconfigured the confirmation link
  // can never reach a real (proxied/public) user, so the hard email gate would
  // permanently lock every signup out of a self-hosted deploy. We cannot verify
  // the address, so don't pretend to — mark it verified and sign the user in.
  // Loopback requests are exempt: the operator keeps the real confirm-email flow
  // (and dev link) so it stays testable locally.
  if (!smtpConfigured() && !isLoopback(req)) {
    warnNoMailerAdmit();
    // ASSUMED, not proven: with no mailer we can't confirm the address is the
    // registrant's. Mark it so email-ownership-gated actions (claiming a Stripe
    // subscription by email, /api/billing/link) don't trust it — otherwise an
    // attacker registers a victim's email and adopts their sub (#2606). Login
    // still works; only ownership proof is withheld until a real verification.
    updateProfile(result.profile.id, { emailVerified: true, emailAssumed: true });
    return _establish(req, res, { ...result.profile, emailVerified: true }, 201);
  }

  const { delivery } = sendSignupVerification(req, result.profile); // confirmation email
  // Hard email gate: the account is created but NOT signed in. It cannot log in
  // until the confirmation link is clicked (see handleLocalLogin).
  const body = { ok: true, pendingVerification: true, email, emailDelivery: delivery };
  const devLink = devVerifyLink(req, result.profile);
  if (devLink) body.devVerifyLink = devLink; // loopback + no-SMTP only
  return _json(res, 202, body);
}

/** POST /api/auth/local/login { email, password } */
async function handleLocalLogin(req, res) {
  if (ipBudgetExceeded(req)) return _json(res, 429, { error: "too_many_attempts", detail: "try again later" });
  const b = await _readJson(req);
  if (!b) return _json(res, 400, { error: "invalid_json" });
  const email = String(b.email || "").trim();
  const password = String(b.password || "");
  if (!email || !password) return _json(res, 400, { error: "missing_credentials" });
  if (throttled(req, email)) return _json(res, 429, { error: "too_many_attempts", detail: "try again later" });

  const profile = await verifyLocalLoginAsync(email, password);
  if (!profile) {
    recordFailure(req, email);
    return _json(res, 401, { error: "invalid_credentials" });
  }
  // The seeded test account is an ADMIN with a repo-known default password. The
  // test-auth mechanism gates its own endpoints on (token + direct-only), but the
  // public local-login form did NOT — so a tunnelled deploy that set the token was
  // one known password away from an admin session (#2603). Hold the same gates
  // here: this account can only sign in via the form when test-auth is enabled AND
  // the request is direct (un-proxied loopback), never from the internet.
  if (profile.id === TEST_ID && !(testAuthEnabled() && testIsDirect(req))) {
    recordFailure(req, email);
    return _json(res, 401, { error: "invalid_credentials" });
  }
  clearFailures(req, email);
  // Hard email gate: a local account with an unconfirmed email cannot sign in.
  if (profile.emailVerified !== true) {
    // No-mailer lockout guard (#2065): rescue accounts created before this fix on
    // a mailer-less deploy — a real (proxied/public) user could never clear the
    // gate, so admit them rather than lock them out forever. Loopback stays gated
    // so the operator keeps the testable confirm-email flow.
    if (!smtpConfigured() && !isLoopback(req)) {
      warnNoMailerAdmit();
      updateProfile(profile.id, { emailVerified: true, emailAssumed: true }); // assumed, not proven (#2606)
      return _establish(req, res, { ...profile, emailVerified: true }, 200);
    }
    const body = { error: "email_unverified", email };
    const devLink = devVerifyLink(req, profile);
    if (devLink) body.devVerifyLink = devLink; // loopback + no-SMTP only
    return _json(res, 403, body);
  }
  return _establish(req, res, profile, 200);
}

module.exports = { handleLocalRegister, handleLocalLogin };
