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
} = require("./user-profiles");
const { establishSession } = require("./session-identity");
const { createToken } = require("./auth-tokens");
const { sendVerificationEmail, smtpConfigured } = require("./mailer");

// Fire-and-forget: email the new account a confirmation link (dev fallback logs
// it). Never blocks or fails registration. Returns "sent" when SMTP is configured
// or "logged" when the link only went to the server log/outbox (no SMTP).
function sendSignupVerification(req, profile) {
  try {
    const host = (req.headers && req.headers.host) || "127.0.0.1";
    const proto =
      (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
      (req.socket && req.socket.encrypted ? "https" : "http");
    const token = createToken("verify_email", profile.id, null);
    const link = `${proto}://${host}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    sendVerificationEmail(profile.email, profile.name, link).catch(() => {});
    return smtpConfigured() ? "sent" : "logged";
  } catch (_) {
    return "logged"; // best-effort
  }
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
  const delivery = sendSignupVerification(req, result.profile); // confirmation email
  // Hard email gate: the account is created but NOT signed in. It cannot log in
  // until the confirmation link is clicked (see handleLocalLogin).
  return _json(res, 202, { ok: true, pendingVerification: true, email, emailDelivery: delivery });
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
    return _json(res, 403, { error: "email_unverified", email });
  }
  return _establish(req, res, profile, 200);
}

module.exports = { handleLocalRegister, handleLocalLogin };
