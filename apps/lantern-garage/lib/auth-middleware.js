/**
 * Server-side authentication middleware.
 * Checks role on every request before rendering pages.
 * No client-side flicker - redirects happen server-side.
 */

const { getProfile } = require("./user-profiles");
const { isFlagEnabledOr } = require("./feature-flags");
const { getSessionUser } = require("./session-identity");
const { roleLevel, isStaffRole } = require("./role-hierarchy");

/**
 * Is the Patreon login gate active? Controlled by the admin-toggleable
 * `patreon_auth` feature flag. Defaults ON when the flag has never been created,
 * so the gate never silently drops open on a fresh install — an admin must
 * explicitly create+disable `patreon_auth` to open the site.
 *
 * When OFF, unauthenticated visitors are treated as guests instead of being
 * bounced to /auth.html. Role- and entitlement-gated surfaces (admin pages, the
 * trade API) stay protected: with no Patreon login available, only the
 * local-admin bypass (the owner's own machine) reaches them.
 */
function patreonAuthEnabled() {
  return isFlagEnabledOr("patreon_auth", true);
}

// The IP-based local-admin bypass (isLocalBypass: loopback socket / dev port 4178 /
// LANTERN_LOCAL_ADMIN) was REMOVED. Trusting a socket address as "the owner" is
// unsound behind a reverse proxy/tunnel and made localhost silently look logged-in.
// All dev/test access now flows through the explicit, token-gated test-auth path
// (lib/test-auth.js), which getSessionUser() resolves — so every gate below simply
// evaluates the resulting role, with no bypass short-circuit. Set
// LANTERN_TEST_AUTH_TOKEN and present X-Test-Auth (see lib/test-auth.js).
//
// SIGNOUT_COOKIE is retained: local-auth clears it on successful login. It no longer
// gates any bypass (there is none), but keeping the constant avoids breaking that
// import and lets a future flow reuse the marker.
const SIGNOUT_COOKIE = "ln_signout";

/**
 * Require authentication for a route.
 * Returns true if user is authenticated, false otherwise.
 * Sends appropriate redirect (to /auth.html if not logged in).
 */
function requireAuth(req, res) {
  // Auth gate disabled by an admin → treat everyone as an allowed guest.
  if (!patreonAuthEnabled()) return true;

  const session = getSessionUser(req);

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
  // Role ordering comes from the one canonical hierarchy (role-hierarchy.js).
  const requiredLevel = roleLevel(requiredRole);

  const session = getSessionUser(req);

  if (!session?.id) {
    // Auth gate disabled → treat the visitor as a guest: serve guest-level
    // pages, but still refuse anything that needs a higher tier (admin pages,
    // paid tiers) with a 403 — there is no login to redirect them to, and the
    // gate being off must never expose privileged surfaces.
    if (!patreonAuthEnabled()) {
      if (requiredLevel <= roleLevel("guest")) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Higher tier required; Patreon login is disabled.",
          required: requiredRole,
          current: "guest",
        })
      );
      return false;
    }
    res.writeHead(302, { Location: "/auth.html" });
    res.end();
    return false;
  }

  const userLevel = roleLevel(session.role);

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
 *   - role "admin" → granted (admins hold all entitlements implicitly).
 *   - otherwise → only if the user's profile has entitlements[key] === true.
 * Returns a boolean and never writes to the response.
 */
function hasEntitlement(req, key) {
  const session = getSessionUser(req);
  if (!session?.id) return false;
  if (session.role === "admin") return true;

  // Tier unlocks (product model):
  //   • "trade"     — stocks + Kalshi + AI suggestions — unlocked by the $20
  //                   Deep Dreamer tier and up.
  //   • "ai_trader" — the autonomous AI trader — unlocked by the $200 tier
  //                   (admin, handled by the role check above).
  // The per-account entitlement below remains an override (admins can grant it
  // to a specific free/lower-tier account).
  if (key === "trade" && roleLevel(session.role) >= roleLevel("deep_dreamer")) return true;

  const profile = getProfile(session.id);
  return !!(profile && profile.entitlements && profile.entitlements[key] === true);
}

/**
 * Require a per-feature entitlement. Returns true if allowed; otherwise sends a
 * 403 (or 302 to login when unauthenticated) and returns false.
 */
function requireEntitlement(req, res, key) {
  const session = getSessionUser(req);
  if (!session?.id) {
    // Gate disabled → no login to redirect to; the entitlement still isn't
    // granted to an anonymous visitor, so deny with a 403 (keeps the trade /
    // money API closed to the public even with the gate off).
    if (!patreonAuthEnabled()) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Account required; Patreon login is disabled.",
          entitlement: key,
        })
      );
      return false;
    }
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
 * Non-writing check: is this request from a staff member (admin OR tech_support)?
 * True for a session whose role is in STAFF_ROLES. Gates the
 * account-support surface (accounts.html + /api/accounts/*). Membership is EXACT —
 * a paid tier at the same hierarchy level as tech_support does not qualify. Never
 * writes to the response.
 */
function isStaff(req) {
  return isStaffRole(getSessionUser(req)?.role);
}

/**
 * Require a staff member (admin or tech_support). Returns true if allowed; otherwise
 * sends a 302 to /auth.html when unauthenticated, or a 403 when signed in without a
 * staff role, and returns false. Mirrors requireRole's response contract.
 */
function requireStaff(req, res) {
  const session = getSessionUser(req);
  if (!session?.id) {
    if (!patreonAuthEnabled()) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Staff access required." }));
      return false;
    }
    res.writeHead(302, { Location: "/auth.html?returnTo=" + encodeURIComponent(req.url || "/accounts.html") });
    res.end();
    return false;
  }
  if (isStaffRole(session.role)) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Staff access required", required: "admin or tech_support", current: session.role }));
  return false;
}

/**
 * Non-writing check: does this request belong to an admin?
 * True for a session (real or test-auth emulated) whose role is "admin". Never
 * touches the response — use this to branch on admin status without sending a 403.
 */
function isAdmin(req) {
  return getSessionUser(req)?.role === "admin";
}

/**
 * Non-writing check: does this request meet a minimum role? True for a session
 * whose role level is at least `requiredRole`. Never writes to the response — use
 * it to branch (e.g. render a friendly page) instead of letting requireRole emit a
 * raw JSON 403.
 */
function meetsRole(req, requiredRole) {
  const session = getSessionUser(req);
  if (!session?.id) return false;
  return roleLevel(session.role) >= roleLevel(requiredRole);
}

/**
 * Attach user profile to request for downstream handlers.
 */
function attachProfile(req) {
  const userId = getSessionUser(req)?.id;
  if (userId) {
    req.userProfile = getProfile(userId);
    req.userId = userId;
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requireStaff,
  isStaff,
  hasEntitlement,
  requireEntitlement,
  isAdmin,
  meetsRole,
  SIGNOUT_COOKIE,
  protectStaticPage,
  attachProfile,
  patreonAuthEnabled,
};
