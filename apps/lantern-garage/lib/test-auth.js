/**
 * Test-auth — a token-gated way to authenticate a request as a seeded TEST account
 * for local development and automated (Playwright / API) testing.
 *
 * This REPLACES the old IP-based local-admin bypass (isLocalBypass), which granted
 * admin to any un-proxied loopback hit. That was both a footgun (localhost always
 * looked "logged in as Dev", hiding the real guest UX) and a latent risk behind a
 * reverse proxy. Here, nothing is bypassed unless an explicit token is presented.
 *
 * SECURITY — two independent gates, both must hold:
 *   1. OFF by default: the whole mechanism is inert unless LANTERN_TEST_AUTH_TOKEN
 *      is set in the environment. Production never sets it.
 *   2. Direct-only: even when the token is set, it is refused on any proxied/
 *      tunnelled request (X-Forwarded-*, CF-*, …). A Cloudflare-fronted deploy that
 *      somehow carried the env var still cannot be bypassed from the internet.
 *
 * One seeded identity, caller-chosen ROLE per request — so a single account can
 * emulate guest → supporter → deep_dreamer → admin, and any SSO provider:
 *   • Header  X-Test-Auth: <token>   (+ optional X-Test-Role, X-Test-Provider)
 *   • Query   ?__test=<token>        (+ optional __test_role, __test_provider)
 * The header form is stateless (ideal for Playwright extraHTTPHeaders + curl). The
 * query form lets a plain browser navigation mint a cookie session (see
 * routes/auth.js → /api/auth/test-login and the auth-page role picker).
 *
 * The single integration seam is session-identity.getSessionUser(), which falls
 * back to resolveTestUser(req). Because every gate (requireAuth / requireRole /
 * hasEntitlement / isAdmin / getSessionInfo) reads identity through getSessionUser,
 * they all honor the emulated role automatically — no per-gate bypass check.
 */

"use strict";

const crypto = require("crypto");
const { tokensEqual } = require("./request-auth");
const { roleLevel } = require("./role-hierarchy");
const {
  getProfile,
  updateProfile,
  createProfile,
  hashPassword,
} = require("./user-profiles");

// Headers that only ever appear on traffic relayed through a reverse proxy or
// tunnel. A genuine same-machine request to 127.0.0.1 carries none of these.
// (Kept as a local copy so this module has no dependency on auth-middleware,
// which in turn depends on session-identity → test-auth.)
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "true-client-ip",
];

// The one seeded test identity. Stable id so per-user state (conversations, IBKR
// creds, …) is consistent across runs. Password is only used for the real
// form-login path; override with LANTERN_TEST_PASSWORD.
// LANTERN_TEST_USER_ID lets a dev boot emulate a SPECIFIC profile id so per-user
// state saved under that id (e.g. an IBKR connection, pointed at read-only via
// IBKR_CRED_DIR) can be exercised without duplicating credential files. Same
// token + direct-only gates apply; production never sets any of this.
const TEST_ID = process.env.LANTERN_TEST_USER_ID || "test-user";
const TEST_EMAIL = "test@unisona.local";
const TEST_NAME = "Test User";
const TEST_DEFAULT_PASSWORD = "test-account-1234";

/** Roles the picker/header may emulate. "guest" is excluded (guest = not logged in). */
const TEST_ROLES = ["supporter", "deep_dreamer", "founder", "admin", "tech_support"];

/** Is the test-auth mechanism switched on for this process? */
function testAuthEnabled() {
  return !!process.env.LANTERN_TEST_AUTH_TOKEN;
}

/** The configured token, or "" when disabled. */
function testToken() {
  return process.env.LANTERN_TEST_AUTH_TOKEN || "";
}

/** The seeded test account's password (env-overridable). */
function testPassword() {
  return process.env.LANTERN_TEST_PASSWORD || TEST_DEFAULT_PASSWORD;
}

/** True when the request arrived directly (no proxy/tunnel headers). */
function isDirect(req) {
  const headers = (req && req.headers) || {};
  for (const h of PROXY_HEADERS) {
    if (headers[h]) return false;
  }
  return true;
}

/** Parse the request URL's query params (best-effort; tolerant of odd req.url). */
function _query(req) {
  try {
    const host = (req.headers && req.headers.host) || "127.0.0.1";
    return new URL(req.url || "/", `http://${host}`).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The presented token from header or `?__test=`, or "". */
function presentedToken(req) {
  const h = (req && req.headers) || {};
  if (h["x-test-auth"]) return String(h["x-test-auth"]);
  const q = _query(req).get("__test");
  return q ? String(q) : "";
}

/** Validate + normalize a requested role. Unknown/blank → "admin" (most permissive). */
function normalizeRole(role) {
  const r = String(role || "").trim();
  if (r && TEST_ROLES.includes(r)) return r;
  // roleLevel tolerates custom roles; only accept ones we know are meaningful.
  return "admin";
}

/**
 * Ensure the seeded test profile exists (verified, with a local password so the
 * real /api/auth/local/login path works too). Idempotent; safe to call often.
 * Only does anything when test-auth is enabled.
 */
function ensureTestProfile() {
  if (!testAuthEnabled()) return null;
  let profile = getProfile(TEST_ID);
  const cred = hashPassword(testPassword());
  if (!profile) {
    profile = createProfile(TEST_ID, {
      name: TEST_NAME,
      email: TEST_EMAIL,
      emailVerified: true,
      role: "admin",
      tier: "dev",
      entitlements: { trade: true },
      credential: cred,
      identities: [
        { provider: "local", providerId: TEST_EMAIL, email: TEST_EMAIL, emailVerified: true, linkedAt: new Date().toISOString() },
      ],
      source: "test-auth",
    });
    return profile;
  }
  // Keep the seeded account healthy across password/email changes without spamming
  // the JSONL log: only rewrite when something actually drifted.
  const needs =
    profile.emailVerified !== true ||
    profile.email !== TEST_EMAIL ||
    profile.role !== "admin" ||
    !profile.credential;
  if (needs) {
    profile = updateProfile(TEST_ID, {
      email: TEST_EMAIL,
      emailVerified: true,
      role: "admin",
      tier: "dev",
      entitlements: { trade: true, ...(profile.entitlements || {}) },
      credential: profile.credential || cred,
    });
  }
  return profile;
}

/**
 * Resolve the emulated test user for a request, or null when test-auth does not
 * apply. Returns a canonical session-user object (same shape session-identity
 * produces) with the caller-chosen role/provider.
 */
function resolveTestUser(req) {
  if (!testAuthEnabled()) return null;
  if (!req || !isDirect(req)) return null;
  if (!tokensEqual(presentedToken(req), testToken())) return null;

  const q = _query(req);
  const h = req.headers || {};
  const role = normalizeRole(h["x-test-role"] || q.get("__test_role"));
  const provider = String(h["x-test-provider"] || q.get("__test_provider") || "local");

  const profile = ensureTestProfile();
  if (!profile) return null;

  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    emailVerified: true,
    role,
    tier: profile.tier || "dev",
    provider,
    entitlements: { trade: true },
    // Marker so callers/telemetry can tell an emulated identity apart from a real one.
    isTest: true,
  };
}

module.exports = {
  testAuthEnabled,
  testToken,
  testPassword,
  isDirect,
  presentedToken,
  resolveTestUser,
  ensureTestProfile,
  normalizeRole,
  TEST_ID,
  TEST_EMAIL,
  TEST_NAME,
  TEST_ROLES,
};
