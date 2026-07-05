/**
 * Email confirmation tokens + delivery (ADR-0016 follow-up).
 *
 * A verification link carries a stateless, signed HMAC token — no server-side
 * token store to keep in sync. The token encodes { pid, email, exp }; verifying
 * it and flipping the profile's `emailVerified` flag is idempotent, so a
 * double-clicked link is harmless. Signing reuses the session secret, matching
 * the oauth-core state-cookie convention.
 */

const crypto = require("crypto");
const { sendMail } = require("./mailer");

const TTL_MS = 24 * 60 * 60 * 1000; // links are valid for 24h

function _secret() {
  return (
    process.env.SESSION_SECRET ||
    process.env.PATREON_CLIENT_SECRET ||
    "lantern-local-dev-secret-change-in-prod"
  );
}

/** Mint a signed verification token for a profile + email. */
function mintToken(profileId, email, ttlMs = TTL_MS) {
  const payload = {
    pid: String(profileId),
    email: String(email || "").toLowerCase(),
    exp: Date.now() + ttlMs,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", _secret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Verify a token → its payload, or null if tampered/expired/malformed. */
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", _secret()).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!p || !p.pid || !p.exp || Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Derive the public base URL (scheme + host) for building the link, honoring a
 * reverse proxy / tunnel the same way oauth-core.resolveRedirectUri does, with a
 * PUBLIC_BASE_URL env override for headless sends.
 */
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = req && req.headers && req.headers.host;
  if (host) {
    const proto =
      ((req.headers["x-forwarded-proto"] || "").split(",")[0].trim()) ||
      (req.socket && req.socket.encrypted ? "https" : "http");
    return `${proto}://${host}`;
  }
  return "http://127.0.0.1:4177";
}

/**
 * Build + send a confirmation email for a profile. Returns the mailer result
 * (see mailer.sendMail) so the caller can surface delivery failures.
 */
async function sendVerificationEmail(req, profile) {
  const token = mintToken(profile.id, profile.email);
  const link = `${baseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const name = profile.name || "there";
  const subject = "Confirm your Unisona email";
  const text =
    `Hi ${name},\n\n` +
    `Confirm your email to finish setting up your Unisona account:\n\n${link}\n\n` +
    `This link expires in 24 hours. If you didn't create an account, you can ignore this email.`;
  const html =
    `<p>Hi ${_esc(name)},</p>` +
    `<p>Confirm your email to finish setting up your Unisona account:</p>` +
    `<p><a href="${_esc(link)}">Confirm my email</a></p>` +
    `<p style="color:#666;font-size:13px">This link expires in 24 hours. ` +
    `If you didn't create an account, you can ignore this email.</p>`;
  return sendMail({ to: profile.email, subject, text, html, link });
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

module.exports = { mintToken, verifyToken, sendVerificationEmail, baseUrl };
