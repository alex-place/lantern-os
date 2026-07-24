/**
 * Session helpers for the auth routes — provider-agnostic (ADR-0016). The real
 * OAuth flow lives in oauth-core.js + the registry in auth-providers.js; this
 * module only reports the current session and tears it down on logout.
 *
 * (Formerly lib/patreon-auth.js. Patreon was fully retired as an auth provider;
 * these helpers were never Patreon-specific, so they moved to a neutral name.
 * The cookie helpers are re-exported for the oauth-cookie recovery tests, #689.)
 */

const { signOauth, verifyOauth, readCookie } = require("./oauth-core");
const { getProfile } = require("./user-profiles");
const { getSessionUser } = require("./session-identity");
const { roleLevel } = require("./role-hierarchy");
const { SIGNOUT_COOKIE } = require("./auth-middleware");

/**
 * Current session info for /api/auth/session — provider-agnostic. Reports the
 * resolved role, provider, entitlements, and a compact user object.
 */
function getSessionInfo(req) {
  const user = getSessionUser(req);
  if (user && user.id) {
    const role = user.role || "guest";
    const profile = getProfile(user.id);
    // Keep this IN LOCK-STEP with auth-middleware.hasEntitlement("trade"): trading
    // is unlocked by the $20 Deep Dreamer tier and up (roleLevel), by admin, or by
    // an explicit per-account entitlement override. If this drifts from the server
    // gate, a paid trader gets the read-only UI while the API lets them trade (or
    // vice-versa). #trade-entitlement-consistency
    const trade =
      role === "admin" ||
      roleLevel(role) >= roleLevel("deep_dreamer") ||
      !!(profile && profile.entitlements && profile.entitlements.trade === true);
    return {
      authenticated: true,
      role,
      provider: user.provider || "local",
      entitlements: { trade },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        provider: user.provider || "local",
      },
    };
  }

  // No IP-based bypass. A dev/test session is established via test-auth
  // (lib/test-auth.js), which getSessionUser() resolves above — so an emulated
  // identity takes the authenticated branch just like a real one. A genuine guest
  // (no session, no valid test token) is reported as such and sent to /auth.html.
  return { authenticated: false, role: "guest" };
}

/** Logout: destroy the session. */
function handleLogout(req, res) {
  // Drop a short-lived marker (cleared when the user logs back in). Retained from
  // the removed dev-port admin bypass so a future flow can reuse the marker.
  const signoutCookie =
    `${SIGNOUT_COOKIE}=1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`;
  const done = (status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Set-Cookie": signoutCookie,
    });
    res.end(JSON.stringify(body));
  };
  if (req.session) {
    req.session.destroy((err) => {
      if (err) return done(500, { error: err.message });
      done(200, { ok: true });
    });
  } else {
    done(200, { ok: true });
  }
}

module.exports = {
  getSessionInfo,
  handleLogout,
  // re-exported for tests (issue #689 oauth-cookie recovery)
  signOauth,
  verifyOauth,
  readCookie,
};
