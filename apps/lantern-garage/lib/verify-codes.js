/**
 * Short numeric email-confirmation codes for signup (ADR-0016 follow-up).
 *
 * Signup confirmation is a 6-digit code the user types back, not a link they click.
 * That is a deliberately DIFFERENT security model from lib/auth-tokens.js: a signed
 * token is ~300 bits of entropy and can safely be stateless, but a 6-digit code is
 * one-in-a-million and would be brute-forceable in seconds if it were only bounded
 * by its TTL. So a code is:
 *
 *   - stored server-side, HMAC-hashed, never in plaintext (a leaked store must not
 *     hand out working codes)
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
const { resolveSessionSecret } = require("./session-secret");

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;

function secret() {
  // Namespaced so a code hash can never collide with an action token or session cookie.
  return "verifycode:" + resolveSessionSecret();
}

function storePath() {
  return path.resolve(process.cwd(), "data", "auth", "verify-codes.jsonl");
}

/** HMAC the code, bound to the profile id so a code is only valid for its own account. */
function hashCode(profileId, code) {
  return crypto.createHmac("sha256", secret()).update(`${profileId}:${code}`).digest("base64url");
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
function issueCode(profileId, email = null) {
  // randomInt is uniform over the range; `% 1000000` on random bytes would not be.
  const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  _persist({
    sub: String(profileId),
    email: email || null,
    hash: hashCode(profileId, code),
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
function checkCode(profileId, code) {
  const rec = _load().get(String(profileId));
  if (!rec) return { ok: false, reason: "none" };
  if (Date.now() > rec.exp) return { ok: false, reason: "expired" };
  if (rec.consumed) return { ok: false, reason: "used" };
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  const given = Buffer.from(hashCode(profileId, String(code || "")));
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
