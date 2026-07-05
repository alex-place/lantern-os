/**
 * Provider-agnostic session identity resolver — the ONE way to ask "who is this
 * request?" regardless of which provider (patreon / google / discord / local)
 * authenticated it.
 *
 * Canonical shape written on login is `req.session.user`:
 *   { id, name, email, emailVerified, role, provider, tier, entitlements? }
 * where `id` is the local PROFILE id (stable across linked providers), NOT any
 * one provider's id.
 *
 * Backward compatibility: the Patreon path historically wrote `req.session.patreon`
 * and several tests construct `{ session: { patreon: {...} } }` directly. We fall
 * back to it so nothing breaks during the migration window. Remove the fallback one
 * release after rollout (see ADR-0016 follow-ups).
 */

/**
 * Resolve the canonical user object for a request, or null if unauthenticated.
 * @returns {{id?:string, role?:string, provider?:string, email?:string, name?:string, tier?:string}|null}
 */
function getSessionUser(req) {
  const s = req && req.session;
  if (!s) return null;
  if (s.user && s.user.id) return s.user;
  // Compat: legacy Patreon-shaped session.
  if (s.patreon && s.patreon.id) {
    const p = s.patreon;
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      tier: p.tier,
      provider: "patreon",
    };
  }
  return null;
}

/** Convenience: the resolved profile id for a request, or null. */
function getSessionUserId(req) {
  const u = getSessionUser(req);
  return u ? u.id : null;
}

/** Convenience: the resolved role for a request, or "guest". */
function getSessionRole(req) {
  const u = getSessionUser(req);
  return (u && u.role) || "guest";
}

/**
 * Write the canonical identity onto a session. Also mirrors the legacy
 * `session.patreon` shape when the provider is patreon, so any not-yet-migrated
 * reader (or the Discord-link path that still keys on a Patreon id) keeps working.
 */
function setSessionUser(req, user) {
  req.session.user = user;
  req.session.authenticated = true;
  if (user && user.provider === "patreon") {
    req.session.patreon = {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      role: user.role,
      token: user.token,
      expiresAt: user.expiresAt,
    };
  }
  // #2041: an authenticated session start is a daily-active retention signal.
  // Recorded at most once per actor per UTC day. Fire-and-forget + non-fatal —
  // telemetry must never break login.
  try {
    const actor = (user && (user.email || user.name || user.id)) || "";
    if (actor) {
      Promise.resolve(
        require("./traction").recordDailyActive({
          actor,
          verified: true,
          source: "session-start",
          evidence: "req.session.user",
        })
      ).catch(() => { /* non-fatal */ });
    }
  } catch { /* traction never breaks login */ }
}

/**
 * Establish an authenticated session for `user`, regenerating the session id first
 * to defeat session fixation (a pre-set SID must not survive a privilege change),
 * then persisting. Calls `done(err)` when saved. Falls back gracefully if the
 * session store lacks regenerate/save (e.g. a plain object in a unit test).
 */
function establishSession(req, user, done) {
  const finish = () => {
    setSessionUser(req, user);
    if (typeof req.session.save === "function") req.session.save(done);
    else done && done(null);
  };
  if (req.session && typeof req.session.regenerate === "function") {
    req.session.regenerate(() => finish()); // best-effort: still establish on error
  } else {
    finish();
  }
}

module.exports = { getSessionUser, getSessionUserId, getSessionRole, setSessionUser, establishSession };
