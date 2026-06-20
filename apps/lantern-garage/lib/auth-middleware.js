/**
 * Server-side authentication middleware.
 * Checks role on every request before rendering pages.
 * No client-side flicker - redirects happen server-side.
 */

const { getProfile } = require("./user-profiles");

// Headers that only ever appear on traffic relayed through a reverse proxy or
// tunnel (Cloudflare in front of lantern-os.net, nginx, Railway, etc.). A
// genuine same-machine request from the owner's browser to 127.0.0.1 carries
// none of these.
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

/**
 * Local-only access bypass (grants admin).
 * Two triggers, both intended for the owner's own machine only:
 *   1. Dev server on port 4178 (existing behavior).
 *   2. LANTERN_LOCAL_ADMIN=1 AND the request arrives on a loopback address.
 *
 * SECURITY: the loopback socket address is NOT proof of a local owner when the
 * server sits behind a reverse proxy or tunnel. lantern-os.net is fronted by
 * Cloudflare, so every visitor reaches Node from a loopback/proxy socket — the
 * old check handed admin (read + write of feature flags and nav) to the entire
 * internet. We therefore deny the bypass outright whenever the request carries
 * any proxy/forwarding header; only a direct, un-proxied local hit qualifies.
 */
function isLocalBypass(req) {
  const headers = req.headers || {};
  for (const h of PROXY_HEADERS) {
    if (headers[h]) return false; // came through a proxy/tunnel → never "local"
  }
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
 * Non-writing check: does this request belong to an admin?
 * True for the local bypass (dev port 4178 / LANTERN_LOCAL_ADMIN on loopback)
 * or a session whose role is "admin". Never touches the response — use this
 * when you need to branch on admin status without sending a 403.
 */
function isAdmin(req) {
  if (isLocalBypass(req)) return true;
  return req.session?.patreon?.role === "admin";
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
  isAdmin,
  protectStaticPage,
  attachProfile,
};
