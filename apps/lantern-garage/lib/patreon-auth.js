/**
 * Patreon auth — now a thin compatibility facade over the provider-agnostic engine
 * (ADR-0016). The real OAuth flow lives in oauth-core.js + the registry in
 * auth-providers.js; Patreon is just one registered provider.
 *
 * This file keeps its historical public API so existing importers and tests
 * (test_patreon_oauth_cookie.js imports signOauth/verifyOauth/readCookie) keep
 * working unchanged. New code should prefer oauth-core / auth-providers directly.
 */

const {
  handleOAuthStart,
  handleOAuthCallback,
  signOauth,
  verifyOauth,
  readCookie,
} = require("./oauth-core");
const { PROVIDERS } = require("./auth-providers");
const { getProfile } = require("./user-profiles");
const { getSessionUser } = require("./session-identity");
const { roleLevel } = require("./role-hierarchy");

/** Start Patreon OAuth (delegates to the generic engine). */
function handlePatreonStart(req, res, returnTo) {
  return handleOAuthStart("patreon", req, res, returnTo);
}

/** Handle the Patreon OAuth callback (delegates to the generic engine). */
async function handlePatreonCallback(req, res, query /*, deps */) {
  return handleOAuthCallback("patreon", req, res, query);
}

/** Map Patreon tier ids to a role (delegates to the registry's Patreon mapper). */
function mapPatreonTierToRole(tierIds) {
  return PROVIDERS.patreon.mapRole({ memberships: tierIds || [] });
}

/**
 * Current session info for /api/auth/session — provider-agnostic. Reports the
 * resolved role, provider, entitlements, and a compact user object; falls back to
 * the local-admin bypass on the owner's own machine.
 */
function getSessionInfo(req) {
  const user = getSessionUser(req);
  if (user && user.id) {
    const role = user.role || "guest";
    const profile = getProfile(user.id);
    const trade = role === "admin" || !!(profile && profile.entitlements && profile.entitlements.trade === true);
    return {
      authenticated: true,
      role,
      provider: user.provider || "patreon",
      entitlements: { trade },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        provider: user.provider || "patreon",
      },
    };
  }

  // Local-only admin bypass (matches auth-middleware isLocalBypass):
  // dev port 4178, or LANTERN_LOCAL_ADMIN=1 on a loopback connection.
  const devPort = req.socket && req.socket.localPort;
  const ip = (req.socket && req.socket.remoteAddress) || "";
  const loopbackAdmin =
    process.env.LANTERN_LOCAL_ADMIN === "1" &&
    (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
  if (devPort === 4178 || loopbackAdmin) {
    return {
      authenticated: true,
      role: "admin",
      provider: "local-bypass",
      entitlements: { trade: true },
      user: { id: "dev", name: "Dev", email: "", tier: "dev", provider: "local-bypass" },
    };
  }
  return { authenticated: false, role: "guest" };
}

/** Logout: destroy the session. */
function handleLogout(req, res) {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

/**
 * Legacy middleware: require a role. Kept for backward-compat (provider-agnostic).
 * New code should use auth-middleware.requireRole.
 */
function requirePatreonRole(requiredRole) {
  const requiredLevel = roleLevel(requiredRole);
  return (req, res, next) => {
    const session = getSessionInfo(req);
    if (roleLevel(session.role) < requiredLevel) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Insufficient permissions", required: requiredRole, current: session.role })
      );
    }
    req.userSession = session;
    next();
  };
}

module.exports = {
  handlePatreonStart,
  handlePatreonCallback,
  getSessionInfo,
  handleLogout,
  requirePatreonRole,
  mapPatreonTierToRole,
  // re-exported for tests (issue #689 oauth-cookie recovery)
  signOauth,
  verifyOauth,
  readCookie,
};
