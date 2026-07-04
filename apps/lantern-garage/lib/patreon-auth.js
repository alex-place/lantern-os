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
const { SIGNOUT_COOKIE } = require("./auth-middleware");

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

  // Local-only admin bypass. Delegate to the SINGLE hardened check in
  // auth-middleware (isLocalBypass) — it additionally denies the bypass whenever
  // the request carries any proxy/tunnel header (cf-ray, x-forwarded-for, …), so
  // public traffic reaching the local server through the Cloudflare tunnel is
  // NOT auto-authenticated as admin. This previously had its own un-hardened copy
  // that only checked the loopback socket, which made every unisona.ai visitor
  // "Dev/admin" and made /auth.html redirect away before anyone could sign in.
  // Lazy-required to avoid any module load-order cycle.
  const { isLocalBypass } = require("./auth-middleware");
  if (isLocalBypass(req)) {
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
  // Drop a short-lived marker so the local/dev-port admin bypass is suppressed —
  // otherwise "Sign out" is a no-op on port 4178 (the bypass re-logs-in "Dev" on
  // the next request). Cleared when the user logs back in. #auth-signout
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
