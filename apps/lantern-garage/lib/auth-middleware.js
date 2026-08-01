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
 * Is the login gate active? Controlled by the admin-toggleable feature flag.
 * Defaults ON when the flag has never been created, so the gate never silently
 * drops open on a fresh install — an admin must explicitly create+disable it to
 * open the site.
 *
 * The stored flag key is still `patreon_auth` for back-compat with existing
 * admin toggles (the gate predates the Patreon retirement and was never
 * Patreon-specific in function — it just decides whether guests are bounced to
 * /auth.html). When OFF, unauthenticated visitors are treated as guests. Role-
 * and entitlement-gated surfaces (admin pages, the trade API) stay protected.
 */
function loginGateEnabled() {
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
 * The role to make access decisions on for a request.
 *
 * For a REAL session this is the PERSISTED profile role (fresh from getProfile),
 * NOT the role snapshotted into the cookie at login. A Stripe cancel / refund /
 * chargeback (and an admin demotion) updates the profile but cannot reach a live
 * cookie session — so gating on the session role let a charged-back user keep
 * Pro / trade / the autonomous trader for the cookie's whole lifetime (#2605,
 * and role demotions for #2627). Re-deriving from the profile makes a revoke take
 * effect on the very next request. getProfile is cache-backed, so this is a cache
 * hit on the hot path.
 *
 * A test-auth EMULATED session (isTest) has no separate persisted role to trust —
 * its profile is always the seeded admin — so honor the caller-chosen session role
 * (the dev role picker). Returns null when unauthenticated.
 */
function effectiveRole(req) {
  const session = getSessionUser(req);
  if (!session?.id) return null;
  if (session.isTest) return session.role;
  const profile = getProfile(session.id);
  return (profile && profile.role) || session.role;
}

/**
 * Require authentication for a route.
 * Returns true if user is authenticated, false otherwise.
 * Sends appropriate redirect (to /auth.html if not logged in).
 */
function requireAuth(req, res) {
  // Auth gate disabled by an admin → treat everyone as an allowed guest.
  if (!loginGateEnabled()) return true;

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
    if (!loginGateEnabled()) {
      if (requiredLevel <= roleLevel("guest")) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Higher tier required; login is disabled.",
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

  const currentRole = effectiveRole(req);
  const userLevel = roleLevel(currentRole);

  if (userLevel < requiredLevel) {
    // Insufficient role
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Insufficient permissions",
        required: requiredRole,
        current: currentRole,
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
/**
 * Has this user connected their own brokerage account?
 *
 * True when per-user broker credentials exist on disk for them — today that is
 * Alpaca (OAuth token or BYOK key pair, both via lib/alpaca-credentials). Lazy
 * require + try/catch on the same principle as the plan matrix below: a storage
 * problem must never widen access, so any failure resolves to "not connected".
 */
function brokerConnected(userId) {
  if (!userId) return false;
  try {
    return !!require("./alpaca-credentials").has(userId);
  } catch {
    return false;
  }
}

function hasEntitlement(req, key) {
  const session = getSessionUser(req);
  if (!session?.id) return false;
  // Decide on the PERSISTED role so a revoked subscription (or demotion) drops the
  // entitlement immediately, instead of persisting for the cookie lifetime (#2605).
  const role = effectiveRole(req);
  if (role === "admin") return true;

  // #2550 — four-plan capability matrix, ALWAYS ON (operator, 2026-07-31: "I don't
  // want hidden flags in the code — remove it or leave it on"). It used to sit
  // behind PLAN_ENFORCEMENT=1, which meant the product shipped for months giving
  // away capabilities the pricing page sold. The flag is gone; the matrix is the
  // gate.
  //
  // This block only ever GRANTS. A capability the matrix does not cover falls
  // through to the legacy role checks below, so the matrix can widen access but
  // never silently narrow it.
  try {
    const pm = require("./plan-matrix");
    const capName = Object.keys(pm.CAPABILITIES).find((c) => pm.CAPABILITIES[c].entitlement === key) || key;
    if (pm.minPlanForCapability(capName) && pm.roleHasCapability(role, capName)) return true;
  } catch { /* the matrix must never break the legacy gate */ }

  // Tier unlocks (product model — keyed off role level, itself derived from the
  // Patreon pledge amount in auth-providers.js):
  //   • "pro"       — Pro content features (Creator Suite, image/vision/document
  //                   generation, wide research) — the $20 Pro tier (deep_dreamer) and up.
  //   • "trade"     — stocks + Kalshi + broker connect + AI suggestions — the $20 Pro
  //                   tier (deep_dreamer) and up.
  //   • "ai_trader" — the AUTONOMOUS AI trader (bot executes on your account) — the
  //                   $200 Pilot tier (pilot) and up. Strictly above Pro.
  // The per-account entitlement below remains an override (admins can grant any key
  // to a specific lower-tier account).
  if ((key === "trade" || key === "pro") && roleLevel(role) >= roleLevel("deep_dreamer")) return true;
  if (key === "ai_trader" && roleLevel(role) >= roleLevel("pilot")) return true;

  // Own-broker trading is a FREE-tier capability (operator decision, 2026-07-31).
  // A signed-in user who has connected their OWN brokerage account with their OWN
  // credentials is trading their own money on their own venue — we are the client,
  // not the counterparty, so there is nothing to gate behind a plan. Pro still buys
  // the terminal extras (AI tradelist, advisor, alerts) and Pilot the autonomous
  // trader; this only unlocks placing orders through a broker you connected.
  //
  // Deliberately NOT reachable by an anonymous visitor: the `session?.id` check at
  // the top of this function already returned false for a sessionless caller, so a
  // guest can never satisfy this branch no matter what is stored on disk.
  if (key === "trade" && brokerConnected(session.id)) return true;

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
    if (!loginGateEnabled()) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Account required; login is disabled.",
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
  return isStaffRole(effectiveRole(req));
}

/**
 * Require a staff member (admin or tech_support). Returns true if allowed; otherwise
 * sends a 302 to /auth.html when unauthenticated, or a 403 when signed in without a
 * staff role, and returns false. Mirrors requireRole's response contract.
 */
function requireStaff(req, res) {
  const session = getSessionUser(req);
  if (!session?.id) {
    if (!loginGateEnabled()) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Staff access required." }));
      return false;
    }
    res.writeHead(302, { Location: "/auth.html?returnTo=" + encodeURIComponent(req.url || "/accounts.html") });
    res.end();
    return false;
  }
  // #2627: gate on the PERSISTED profile role (effectiveRole), NOT the role
  // snapshotted into the cookie at login — otherwise a demoted admin/tech_support
  // keeps staff access for the cookie's whole lifetime. This mirrors requireRole /
  // isStaff / isAdmin, which already re-derive; requireStaff was the lone gate still
  // trusting session.role. (Currently exported-but-unwired — fixed so a future route
  // that adopts it doesn't silently reintroduce the stale-role hole.)
  const role = effectiveRole(req);
  if (isStaffRole(role)) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Staff access required", required: "admin or tech_support", current: role }));
  return false;
}

/**
 * Non-writing check: does this request belong to an admin?
 * True for a session (real or test-auth emulated) whose role is "admin". Never
 * touches the response — use this to branch on admin status without sending a 403.
 */
function isAdmin(req) {
  return effectiveRole(req) === "admin";
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
  return roleLevel(effectiveRole(req)) >= roleLevel(requiredRole);
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
  loginGateEnabled,
};
