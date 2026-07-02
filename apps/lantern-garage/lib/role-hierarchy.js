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
 */
const ROLE_HIERARCHY = Object.freeze({
  guest: 0,
  supporter: 1,
  deep_dreamer: 2,
  founder: 2, // legacy alias for deep_dreamer (#698)
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

module.exports = { ROLE_HIERARCHY, roleLevel, roleMeets };
