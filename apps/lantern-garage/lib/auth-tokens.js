/**
 * Stateless, HMAC-signed action tokens for email verification and password reset
 * (ADR-0016 follow-up). No server-side store — the token carries its own payload
 * and an expiry, signed with the session secret so it can't be forged or tampered.
 *
 * Payload: { p: purpose, sub: profileId, e: email|null, exp: epochMs }
 * Token:   base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dataPath } = require("./app-paths");
const { resolveSessionSecret } = require("./session-secret");

function secret() {
  // Namespaced so these tokens can't be confused with session cookies.
  return "authtok:" + resolveSessionSecret();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64) {
  // A MAC over a token payload, not a stored password. The security here is the ~300-bit
  // secret key plus a short TTL, not hash slowness; a KDF would add latency and buy
  // nothing, because there is no low-entropy value for an attacker to enumerate.
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url"); // codeql[js/insufficient-password-hash]
}

const TTL = {
  verify_email: 24 * 60 * 60 * 1000, // 24h
  reset_password: 60 * 60 * 1000,    // 1h
};

/** Create a token for `purpose` bound to a profile id (and optional email). Each token
 *  carries a random `jti` so it can be marked single-use via consumeToken() (#2614). */
function createToken(purpose, profileId, email = null) {
  const exp = Date.now() + (TTL[purpose] || 60 * 60 * 1000);
  const jti = crypto.randomBytes(9).toString("base64url");
  const payload = b64url(JSON.stringify({ p: purpose, sub: String(profileId), e: email || null, exp, jti }));
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
  return { sub: payload.sub, email: payload.e || null, jti: payload.jti || null, exp: payload.exp };
}

// ── Single-use ledger — a signed token is otherwise replayable for its whole TTL, so a
// leaked reset/verify link works again even after the legitimate user used it (#2614).
// jti → expiry, in-memory + an append log under the single data root (survives restart),
// pruned on load. Anchored via app-paths.dataPath, never the cwd (#3088).
function ledgerPath() { return dataPath("auth", "consumed-tokens.jsonl"); }
let _consumed = null; // Map<jti, exp>
function _load() {
  if (_consumed) return _consumed;
  _consumed = new Map();
  const now = Date.now();
  try {
    for (const line of fs.readFileSync(ledgerPath(), "utf8").split("\n")) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o.jti && o.exp > now) _consumed.set(o.jti, o.exp); } catch { /* skip */ }
    }
  } catch { /* no ledger yet */ }
  return _consumed;
}

/** Has this token id already been spent? */
function isConsumed(jti) { return !!(jti && _load().has(jti)); }

/**
 * Mark a token id spent. Returns true if this call consumed it (first use), false if it
 * was ALREADY consumed (a replay) — callers reject on false. `exp` bounds ledger growth.
 */
function consumeToken(jti, exp) {
  if (!jti) return true; // legacy token without a jti — nothing to dedupe against
  const map = _load();
  if (map.has(jti)) return false;
  map.set(jti, exp || Date.now() + 24 * 60 * 60 * 1000);
  try {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.appendFileSync(ledgerPath(), JSON.stringify({ jti, exp: map.get(jti) }) + "\n");
  } catch { /* best-effort; the in-memory set still blocks replays this process */ }
  return true;
}

module.exports = { createToken, verifyToken, isConsumed, consumeToken, ledgerPath };
