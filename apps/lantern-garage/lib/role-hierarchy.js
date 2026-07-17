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
  supporter: 1, // legacy $5 Member Patreon tier (retired #2613; grandfathered patrons only, not sold)
  deep_dreamer: 2, // $20 Pro tier
  founder: 2, // legacy alias for deep_dreamer (#698)
  // Staff support role: can operate the account-support surface (accounts.html) to
  // fix multi-auth / password issues, but is NOT admin — level 2 keeps admin-only
  // surfaces (feature flags, nav, real-money switches) closed. The support page gates
  // on an EXPLICIT {admin, tech_support} set, not this level, so paid tiers at the
  // same level never reach it. See auth-middleware.isStaff.
  tech_support: 2,
  // $200 Pilot tier — the top PURCHASABLE tier. Sits above Pro so it can unlock
  // Pilot-only capabilities (the autonomous AI trader, via the `ai_trader`
  // entitlement) without granting the operator `admin` role, which is never
  // purchasable (see auth-providers.resolveRole). Mapped from the $200 pledge amount.
  pilot: 3,
  admin: 4,
});

// The staff roles allowed on the account-support surface. Membership is exact —
// NOT a hierarchy-level check — so a paid tier sharing tech_support's level can't
// slip into account administration.
const STAFF_ROLES = Object.freeze(["admin", "tech_support"]);

/** Numeric level for a role name (unknown → 0, the guest floor). */
function roleLevel(role) {
  return ROLE_HIERARCHY[role] || 0;
}

/** True iff `role` meets or exceeds `required` in the hierarchy. */
function roleMeets(role, required) {
  return roleLevel(role) >= roleLevel(required);
}

/**
 * The higher-privilege of two role names (by hierarchy level). Ties keep `a`.
 * Used to make role resolution monotonic across a profile's linked sign-in
 * methods: logging in with a guest-mapping provider (Google/Discord) must never
 * downgrade a role already earned via Patreon.
 */
function higherRole(a, b) {
  return roleLevel(b) > roleLevel(a) ? b : a;
}

/** True iff `role` is a staff support role (exact membership, not a level check). */
function isStaffRole(role) {
  return STAFF_ROLES.includes(role);
}

module.exports = { ROLE_HIERARCHY, STAFF_ROLES, roleLevel, roleMeets, higherRole, isStaffRole };
