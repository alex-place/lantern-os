/**
 * Canonical role hierarchy — the ONE source of truth for role ordering.
 *
 * Consolidates the literal that used to be duplicated inline in
 * auth-middleware.js (requireRole) and patreon-auth.js (requirePatreonRole).
 * Roles are provider-agnostic: whichever provider (patreon / google / discord /
 * local) issued the session, a role name means the same thing here.
 *
 * `deep_dreamer` is the $20 web tier; `founder` is kept as a legacy alias at the
 * same level so sessions/profiles persisted before the #698 rename still resolve.
 *
 * `tech_support` is an internal operator role. It can access account-repair tools
 * but remains below `admin`, so support users do not automatically gain every
 * admin-only control surface.
 *
 * NOTE on `guest` (#1879): the `guest` level (0) is the *authenticated free tier*
 * — a signed-in user on no paid plan — NOT an anonymous visitor. "Can this page
 * load without a login?" is a separate question answered upstream by whether the
 * request carries a session at all (getSessionUser → session.id): requireRole
 * treats a session-less caller as guest-level only when the auth gate is off, and
 * otherwise redirects them to login. The name is retained (not renamed to `free`)
 * because it is a persisted role value on existing sessions/profiles; renaming it
 * is a founder-coordinated migration tracked in #1879 / #1876, not a code cleanup.
 */
const ROLE_HIERARCHY = Object.freeze({
  guest: 0, // authenticated free tier (see note above) — NOT anonymous
  supporter: 1,
  deep_dreamer: 2,
  founder: 2, // legacy alias for deep_dreamer (#698)
  tech_support: 2.5,
  admin: 3,
});

/** Numeric level for a role name (unknown → 0, the guest floor). */
function roleLevel(role) {
  return ROLE_HIERARCHY[role] || 0;
}

/** True iff `role` meets or exceeds `required` in the hierarchy. */
function roleMeets(role, required) {
  return roleLevel(role) >= roleLevel(required);
}

/** Return whichever role is higher in the hierarchy. Unknown roles fall to guest. */
function higherRole(a, b) {
  return roleLevel(a) >= roleLevel(b) ? (a || "guest") : (b || "guest");
}

module.exports = { ROLE_HIERARCHY, roleLevel, roleMeets, higherRole };
