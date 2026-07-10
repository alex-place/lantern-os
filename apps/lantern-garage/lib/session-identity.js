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
 * The legacy `req.session.patreon` compat shim (read fallback + write mirror) was
 * removed after the ADR-0016 rollout window: every login now writes `session.user`
 * and every gate reads it, so nothing else references the Patreon-shaped session
 * (ADR-0016 follow-up #1947 item 2).
 */

/**
 * Resolve the canonical user object for a request, or null if unauthenticated.
 * @returns {{id?:string, role?:string, provider?:string, email?:string, name?:string, tier?:string}|null}
 */
function getSessionUser(req) {
  const s = req && req.session;
  if (s && s.user && s.user.id) return s.user;
  // Test-auth fallback (OFF unless LANTERN_TEST_AUTH_TOKEN is set, direct hits only).
  // This is the ONE seam the whole test-auth mechanism plugs into: every gate reads
  // identity through getSessionUser, so honoring the emulated role here makes
  // requireAuth / requireRole / hasEntitlement / isAdmin / getSessionInfo all work
  // without a per-gate bypass. Lazy-require avoids a load-order cycle.
  try {
    const { resolveTestUser } = require("./test-auth");
    const t = resolveTestUser(req);
    if (t) return t;
  } catch (_) { /* test-auth unavailable → no fallback */ }
  return null;
}

/** Convenience: the resolved profile id for a request, or null. */
function getSessionUserId(req) {
  const u = getSessionUser(req);
  return u ? u.id : null;
}

/**
 * The user id to key per-user state (IBKR creds, etc.) on — the session profile id,
 * or null for a guest. Under test-auth this is the seeded test account's id (so the
 * operator can connect + test per-user features locally without a full login),
 * because getSessionUser() already resolves the emulated identity. The old
 * IP-based "local-owner" bypass is gone — nothing is trusted by socket address.
 */
function getEffectiveUserId(req) {
  return getSessionUserId(req);
}

/** Convenience: the resolved role for a request, or "guest". */
function getSessionRole(req) {
  const u = getSessionUser(req);
  return (u && u.role) || "guest";
}

/**
 * Write the canonical identity onto a session. Provider-agnostic: every provider
 * (patreon / google / discord / local) writes the same `session.user` shape.
 */
function setSessionUser(req, user) {
  req.session.user = user;
  req.session.authenticated = true;
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

module.exports = { getSessionUser, getSessionUserId, getEffectiveUserId, getSessionRole, setSessionUser, establishSession };
