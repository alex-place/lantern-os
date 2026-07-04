/**
 * Stateless, HMAC-signed action tokens for email verification and password reset
 * (ADR-0016 follow-up). No server-side store — the token carries its own payload
 * and an expiry, signed with the session secret so it can't be forged or tampered.
 *
 * Payload: { p: purpose, sub: profileId, e: email|null, exp: epochMs }
 * Token:   base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 */

const crypto = require("crypto");
const { resolveSessionSecret } = require("./session-secret");

function secret() {
  // Namespaced so these tokens can't be confused with session cookies.
  return "authtok:" + resolveSessionSecret();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

const TTL = {
  verify_email: 24 * 60 * 60 * 1000, // 24h
  reset_password: 60 * 60 * 1000,    // 1h
};

/** Create a token for `purpose` bound to a profile id (and optional email). */
function createToken(purpose, profileId, email = null) {
  const exp = Date.now() + (TTL[purpose] || 60 * 60 * 1000);
  const payload = b64url(JSON.stringify({ p: purpose, sub: String(profileId), e: email || null, exp }));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a token. Returns { sub, email } on success or null (bad signature,
 * wrong purpose, malformed, or expired). Uses a constant-time signature compare.
 */
function verifyToken(token, expectedPurpose) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.p !== expectedPurpose) return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return { sub: payload.sub, email: payload.e || null };
}

module.exports = { createToken, verifyToken };
