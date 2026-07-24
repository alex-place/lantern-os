"use strict";

// The committed dev convenience secret. It must NEVER sign sessions beyond
// loopback — its value is public in the repo. #867
const DEFAULT_DEV_SECRET = "lantern-local-dev-secret-change-in-prod";

/**
 * Resolve the express-session signing secret with a fail-closed posture.
 *
 * The committed dev default is allowed ONLY on loopback (no PORT set and not
 * production). When bound beyond loopback — `PORT` set (Railway/tunnel) or
 * `NODE_ENV==='production'` — a real `SESSION_SECRET` is REQUIRED; a missing or
 * default secret throws so the caller can refuse to boot rather than sign
 * sessions with a publicly-known key.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {string} the secret to use
 * @throws {Error} when bound beyond loopback without a real secret
 */
function resolveSessionSecret(env = process.env) {
  const isNonLocal = !!env.PORT || env.NODE_ENV === "production";
  const secret = env.SESSION_SECRET;

  if (!secret) {
    if (isNonLocal) {
      throw new Error(
        "SESSION_SECRET is required when binding beyond loopback (PORT set or " +
        "NODE_ENV=production). Refusing to sign sessions with the committed dev default."
      );
    }
    return DEFAULT_DEV_SECRET; // loopback-only dev convenience
  }
  if (secret === DEFAULT_DEV_SECRET && isNonLocal) {
    throw new Error(
      "SESSION_SECRET is the committed dev default in a non-local deploy " +
      "(PORT set or NODE_ENV=production). Refusing to boot."
    );
  }
  return secret;
}

module.exports = { resolveSessionSecret, DEFAULT_DEV_SECRET };
