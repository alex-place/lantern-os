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
  markEmailVerified,
  getProfileByEmail,
  publicProfile,
} = require("./user-profiles");
const { track, EVENTS } = require("./metrics");
const { establishSession } = require("./session-identity");
const { sendVerificationEmail, verifyToken } = require("./email-verification");

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
function _json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
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

/**
 * POST /api/auth/local/register { email, password, name }
 *
 * Hard email gate: registration creates the account but does NOT establish a
 * session. A confirmation email is sent; the user cannot sign in until they click
 * the link (see handleLocalLogin). Returns 202 { ok, pendingVerification: true }.
 */
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
  track(EVENTS.SIGNUP, { actorId: result.profile.id, props: { source: "local" } });

  const delivery = await sendVerificationEmail(req, result.profile).catch((e) => ({
    ok: false,
    error: e.message,
  }));
  return _json(res, 202, {
    ok: true,
    pendingVerification: true,
    email,
    // "logged" means no SMTP configured — surfaced so the owner knows the link is
    // in the server log/outbox, not an inbox.
    emailDelivery: delivery.delivery || (delivery.ok ? "sent" : "failed"),
  });
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
  // Hard gate: a local account with an unconfirmed email cannot sign in.
  if (profile.emailVerified !== true) {
    return _json(res, 403, { error: "email_unverified", email });
  }
  track(EVENTS.LOGIN, { actorId: profile.id, props: { source: "local" } });
  return _establish(req, res, profile, 200);
}

/**
 * GET /api/auth/verify-email?token=… — confirm an email from the link. Flips the
 * profile's emailVerified flag and redirects to the login page with a status. We
 * intentionally do NOT auto-establish a session: the user then signs in normally,
 * which keeps the email link from being a bearer credential.
 */
function handleVerifyEmail(req, res, url) {
  const token = url.searchParams.get("token");
  const payload = verifyToken(token);
  const redirect = (q) => {
    res.writeHead(302, { Location: `/auth.html?${q}` });
    res.end();
  };
  if (!payload) return redirect("verify=invalid");
  const updated = markEmailVerified(payload.pid, payload.email);
  if (!updated) return redirect("verify=invalid");
  return redirect("verify=success");
}

/**
 * POST /api/auth/resend-verification { email } — re-send the confirmation email.
 * Always returns a generic 200 (never reveals whether the email exists), and only
 * actually sends for an existing, still-unverified local account.
 */
async function handleResendVerification(req, res) {
  const b = await _readJson(req);
  const email = String((b && b.email) || "").trim();
  if (EMAIL_RE.test(email)) {
    const profile = getProfileByEmail(email);
    if (profile && profile.credential && profile.emailVerified !== true) {
      await sendVerificationEmail(req, profile).catch(() => {});
    }
  }
  return _json(res, 200, { ok: true });
}

module.exports = {
  handleLocalRegister,
  handleLocalLogin,
  handleVerifyEmail,
  handleResendVerification,
};
