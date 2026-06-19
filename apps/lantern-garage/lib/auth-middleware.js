/**
 * Server-side authentication middleware.
 * Checks role on every request before rendering pages.
 * No client-side flicker - redirects happen server-side.
 */

const { getProfile } = require("./user-profiles");

/**
 * Local-only access bypass (grants admin).
 * Two triggers, both safe for production:
 *   1. Dev server on port 4178 (existing behavior).
 *   2. LANTERN_LOCAL_ADMIN=1 AND the request arrives on a loopback address.
 * Cloud deploys bind 0.0.0.0 and never set LANTERN_LOCAL_ADMIN, so remote
 * traffic stays fully gated. Lets the owner reach founder/admin pages
 * (e.g. /create.html) on the local stable server (4177) without Patreon login.
 */
function isLocalBypass(req) {
  if (req.socket?.localPort === 4178) return true;
  if (process.env.LANTERN_LOCAL_ADMIN !== "1") return false;
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Require authentication for a route.
 * Returns true if user is authenticated, false otherwise.
 * Sends appropriate redirect (to /auth.html if not logged in).
 */
function requireAuth(req, res) {
  // Local-only bypass: dev port 4178, or LANTERN_LOCAL_ADMIN on loopback
  if (isLocalBypass(req)) return true;

  const session = req.session?.patreon;

  if (!session?.id) {
    res.writeHead(302, { Location: "/auth.html" });
    res.end();
    return false;
  }

  return true;
}

/**
 * Require a specific role.
 * Returns true if user has required role, false otherwise.
 * Sends 403 Forbidden if insufficient role.
 */
function requireRole(req, res, requiredRole = "supporter") {
  // Local-only bypass: dev port 4178, or LANTERN_LOCAL_ADMIN on loopback
  if (isLocalBypass(req)) return true;

  const session = req.session?.patreon;

  if (!session?.id) {
    res.writeHead(302, { Location: "/auth.html" });
    res.end();
    return false;
  }

  // deep_dreamer is the $20 web tier; `founder` kept as a legacy alias (#698).
  const roleHierarchy = { guest: 0, supporter: 1, deep_dreamer: 2, founder: 2, admin: 3 };
  const userLevel = roleHierarchy[session.role] || 0;
  const requiredLevel = roleHierarchy[requiredRole] || 0;

  if (userLevel < requiredLevel) {
    // Insufficient role
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Insufficient permissions",
        required: requiredRole,
        current: session.role,
      })
    );
    return false;
  }

  return true;
}

/**
 * Middleware to protect static pages (HTML files).
 * Call this before serving HTML to check role.
 * Redirects to login if not authenticated.
 * Set requiredRole to 'guest' to allow free tier, 'supporter' for paid tiers, etc.
 */
function protectStaticPage(requiredRole = "supporter") {
  return (req, res, next) => {
    // Allow public pages
    const publicPaths = ["/", "/auth.html", "/auth", "/index.html"];
    if (publicPaths.includes(req.url)) {
      return next();
    }

    // Check authentication
    if (!requireAuth(req, res)) {
      return;
    }

    // Check role
    if (!requireRole(req, res, requiredRole)) {
      return;
    }

    // User authenticated and has required role
    next();
  };
}

/**
 * Check whether the current request has a per-feature entitlement (e.g. "trade").
 * Rules:
 *   - Local bypass (dev port 4178 / LANTERN_LOCAL_ADMIN on loopback) → granted.
 *   - role "admin" → granted (admins hold all entitlements implicitly).
 *   - otherwise → only if the user's profile has entitlements[key] === true.
 * Returns a boolean and never writes to the response.
 */
function hasEntitlement(req, key) {
  if (isLocalBypass(req)) return true;

  const session = req.session?.patreon;
  if (!session?.id) return false;
  if (session.role === "admin") return true;

  const profile = getProfile(session.id);
  return !!(profile && profile.entitlements && profile.entitlements[key] === true);
}

/**
 * Require a per-feature entitlement. Returns true if allowed; otherwise sends a
 * 403 (or 302 to login when unauthenticated) and returns false.
 */
function requireEntitlement(req, res, key) {
  if (isLocalBypass(req)) return true;

  const session = req.session?.patreon;
  if (!session?.id) {
    res.writeHead(302, { Location: "/auth.html" });
    res.end();
    return false;
  }

  if (hasEntitlement(req, key)) return true;

  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Feature not enabled for this account",
      entitlement: key,
      role: session.role,
    })
  );
  return false;
}

/**
 * Attach user profile to request for downstream handlers.
 */
function attachProfile(req) {
  const userId = req.session?.patreon?.id;
  if (userId) {
    req.userProfile = getProfile(userId);
    req.userId = userId;
  }
}

module.exports = {
  requireAuth,
  requireRole,
  hasEntitlement,
  requireEntitlement,
  protectStaticPage,
  attachProfile,
};
