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
  verifyLocalLogin,
  publicProfile,
  updateProfile,
} = require("./user-profiles");
const { establishSession } = require("./session-identity");
const { createToken } = require("./auth-tokens");
const { sendVerificationEmail, smtpConfigured } = require("./mailer");
const { isLoopback } = require("./request-auth");

/** Build a fresh email-confirmation link (mints a verify_email token). */
function verifyLinkFor(req, profile) {
  const host = (req.headers && req.headers.host) || "127.0.0.1";
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  const token = createToken("verify_email", profile.id, null);
  return `${proto}://${host}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
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
    updateProfile(result.profile.id, { emailVerified: true });
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
  const b = await _readJson(req);
  if (!b) return _json(res, 400, { error: "invalid_json" });
  const email = String(b.email || "").trim();
  const password = String(b.password || "");
  if (!email || !password) return _json(res, 400, { error: "missing_credentials" });
  if (throttled(req, email)) return _json(res, 429, { error: "too_many_attempts", detail: "try again later" });

  const profile = verifyLocalLogin(email, password);
  if (!profile) {
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
      updateProfile(profile.id, { emailVerified: true });
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
