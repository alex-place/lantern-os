/**
 * Server-side authentication middleware.
 * Checks role on every request before rendering pages.
 * No client-side flicker - redirects happen server-side.
 */

const { getProfile } = require("./user-profiles");

/**
 * Require authentication for a route.
 * Returns true if user is authenticated, false otherwise.
 * Sends appropriate redirect (to /auth.html if not logged in).
 */
function requireAuth(req, res) {
  // Dev bypass: port 4178 skips auth gate
  if (req.socket?.localPort === 4178) return true;

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
  // Dev bypass: port 4178 gets admin access
  if (req.socket?.localPort === 4178) return true;

  const session = req.session?.patreon;

  if (!session?.id) {
    res.writeHead(302, { Location: "/auth.html" });
    res.end();
    return false;
  }

  const roleHierarchy = { guest: 0, supporter: 1, founder: 2, admin: 3 };
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
  protectStaticPage,
  attachProfile,
};
