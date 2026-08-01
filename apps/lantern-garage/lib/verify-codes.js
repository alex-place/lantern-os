/**
 * Short numeric email-confirmation codes for signup (ADR-0016 follow-up).
 *
 * Signup confirmation is a 6-digit code the user types back, not a link they click.
 * That is a deliberately DIFFERENT security model from lib/auth-tokens.js: a signed
 * token is ~300 bits of entropy and can safely be stateless, but a 6-digit code is
 * one-in-a-million and would be brute-forceable in seconds if it were only bounded
 * by its TTL. So a code is:
 *
 *   - stored server-side, salted-scrypt-hashed, never in plaintext (a leaked store
 *     must not hand out working codes, and must not be cheaply enumerable either —
 *     10^6 candidates fall instantly to a fast hash)
 *   - single-use, and invalidated by issuing a newer one for the same profile
 *   - capped at MAX_ATTEMPTS wrong guesses, after which it is dead and the user must
 *     request a new one — this, not the TTL, is what makes 10^6 safe
 *
 * The email-CHANGE flow deliberately still uses signed links (routes/profiles.js +
 * the #2646 POST interstitial), because it confirms an address the user is not yet
 * signed in as and lands on a different destination.
 *
 * Store: data/auth/verify-codes.jsonl — append-only, last line per profile wins,
 * pruned of expired records on load. Mirrors the consumed-tokens ledger (#2614).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dataPath } = require("./app-paths");
const TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;

function storePath() {
  return dataPath("auth", "verify-codes.jsonl");
}

// scrypt, not a bare HMAC. A keyed HMAC is unforgeable without the secret, but a
// 6-digit code is only 10^6 candidates: an attacker holding BOTH the store and
// SESSION_SECRET could enumerate every code instantly. scrypt makes that enumeration
// cost real time even in that worst case, and costs one hash per verify otherwise.
// Parameters match lib/user-profiles.hashPassword so there's one cost story in the repo.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/**
 * Hash a code, bound to the profile id so a code is only valid for its own account.
 *
 * Async on purpose: scrypt costs ~45ms, and scryptSync would block the single event
 * loop for that long on every issue and every guess. The per-IP throttle bounds one
 * caller, not a distributed one, so a synchronous hash here is a throughput hole.
 * crypto.scrypt runs on the libuv threadpool instead.
 */
function hashCode(profileId, code, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      `${profileId}:${code}`, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, buf) => (err ? reject(err) : resolve(buf.toString("base64url"))),
    );
  });
}

let _records = null; // Map<profileId, record>

function _load() {
  if (_records) return _records;
  _records = new Map();
  const now = Date.now();
  try {
    for (const line of fs.readFileSync(storePath(), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        // Last write per profile wins; drop anything already expired so the file
        // replaying at boot can't resurrect a dead code.
        if (r && r.sub && r.exp > now) _records.set(String(r.sub), r);
        else if (r && r.sub) _records.delete(String(r.sub));
      } catch { /* skip malformed line */ }
    }
  } catch { /* no store yet */ }
  return _records;
}

function _persist(rec) {
  const map = _load();
  map.set(String(rec.sub), rec);
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.appendFileSync(storePath(), JSON.stringify(rec) + "\n");
  } catch { /* best-effort; in-memory state still governs this process */ }
}

/**
 * Issue a fresh confirmation code for a profile. Returns the PLAINTEXT code — the
 * only moment it exists in the clear, to be handed straight to the mailer. Issuing
 * supersedes any outstanding code for the same profile (so "resend" invalidates the
 * previous email, and a stale code can't be banked).
 */
async function issueCode(profileId, email = null) {
  // randomInt is uniform over the range; `% 1000000` on random bytes would not be.
  const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  const salt = crypto.randomBytes(16).toString("base64url");
  _persist({
    sub: String(profileId),
    email: email || null,
    salt,
    hash: await hashCode(profileId, code, salt),
    exp: Date.now() + TTL_MS,
    attempts: 0,
    consumed: false,
  });
  return code;
}

/**
 * Check a code for a profile. Returns { ok: true } or { ok: false, reason } where
 * reason is one of: none | expired | used | locked | invalid.
 *
 * `invalid` increments the attempt counter; `locked` means the code is spent by
 * failed guesses and only a resend recovers. Callers MUST NOT distinguish these to
 * unauthenticated users beyond what the UI needs, and must not reveal whether the
 * profile exists.
 */
async function checkCode(profileId, code) {
  const rec = _load().get(String(profileId));
  if (!rec) return { ok: false, reason: "none" };
  if (Date.now() > rec.exp) return { ok: false, reason: "expired" };
  if (rec.consumed) return { ok: false, reason: "used" };
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  const given = Buffer.from(await hashCode(profileId, String(code || ""), rec.salt));
  const want = Buffer.from(rec.hash);
  const match = given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!match) {
    _persist({ ...rec, attempts: rec.attempts + 1 });
    // Report the lockout on the attempt that causes it, so the UI can say "request a
    // new code" instead of letting the user keep typing into a dead code.
    return { ok: false, reason: rec.attempts + 1 >= MAX_ATTEMPTS ? "locked" : "invalid" };
  }
  _persist({ ...rec, consumed: true });
  return { ok: true };
}

/** Drop any outstanding code for a profile (used after a successful confirm). */
function clearCode(profileId) {
  const rec = _load().get(String(profileId));
  if (rec) _persist({ ...rec, consumed: true });
}

module.exports = {
  issueCode,
  checkCode,
  clearCode,
  storePath,
  TTL_MS,
  MAX_ATTEMPTS,
  CODE_DIGITS,
};
