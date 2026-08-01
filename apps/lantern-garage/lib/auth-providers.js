/**
 * OAuth provider registry (ADR-0016).
 *
 * Each provider is a small config object — the generic engine in oauth-core.js
 * drives the identical PKCE authorize → token → userinfo dance for all of them.
 * Adding a provider is data, not new machinery. Providers are "configured" only
 * when their client id + secret env vars are present; the login UI shows exactly
 * the configured ones.
 *
 * A provider asserts `emailVerified` ONLY when the upstream says so (Google's
 * `email_verified`). Google is the only OAuth provider; Discord and Patreon were
 * fully retired as sign-in methods.
 */

const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const { roleLevel } = require("./role-hierarchy");

// Per-provider admin overrides, keyed by "<provider>:<providerId>". The OWNER's
// federated user id retains admin regardless of anything else. Set it via
// LANTERN_ADMIN_IDS (comma-separated). A bare id (e.g. "12345678") is interpreted
// as a GOOGLE id — "google:12345678" (Google is the only OAuth provider); qualify
// other identities explicitly ("local:you@email.com"). Keeping the stored key
// provider-qualified prevents a bare id from cross-granting admin to a
// same-numbered id on a different provider.
const _ADMIN_ID_ENTRIES = String(process.env.LANTERN_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_OVERRIDES = new Set(
  _ADMIN_ID_ENTRIES.map((entry) => (entry.includes(":") ? entry : `google:${entry}`))
);

// The providers an override key can actually match (see isAdminOverride callers +
// profileHasAdminOverride). An entry qualified with anything else can never match, and a bare
// entry becomes google:<id> — surprising if you meant your local email account (#3087).
const _KNOWN_OVERRIDE_PROVIDERS = new Set(["google", "patreon", "discord", "local"]);
for (const entry of _ADMIN_ID_ENTRIES) {
  if (!entry.includes(":")) {
    // Bare → google:<id>. If it looks like an email it was almost certainly meant to be a
    // local account, which this will NOT match — the exact silent no-op #3087 describes.
    if (entry.includes("@")) {
      console.warn(
        `[auth] LANTERN_ADMIN_IDS entry "${entry}" is bare, so it is read as a GOOGLE id ` +
          `("google:${entry}") and will NOT elevate an email/password account. Use ` +
          `"local:${entry.toLowerCase()}" for a local login.`
      );
    }
  } else {
    const prov = entry.slice(0, entry.indexOf(":")).toLowerCase();
    if (!_KNOWN_OVERRIDE_PROVIDERS.has(prov)) {
      console.warn(
        `[auth] LANTERN_ADMIN_IDS entry "${entry}" names provider "${prov}", which no login ` +
          `path checks — it can never grant admin. Known: ${[..._KNOWN_OVERRIDE_PROVIDERS].join(", ")}.`
      );
    }
  }
}

function isAdminOverride(provider, providerId) {
  // Strict provider-qualified match. Bare LANTERN_ADMIN_IDS entries were already
  // normalized to "google:<id>" at load, so a bare owner id can't cross-grant admin
  // to a same-numbered id on a different provider.
  return ADMIN_OVERRIDES.has(`${provider}:${providerId}`);
}

// Operational guard: no OAuth tier grants admin — it comes ONLY from an admin
// override or an explicit setUserRole. Warn loudly at startup if none is set so a
// fresh deploy doesn't silently ship with an unreachable admin.
if (ADMIN_OVERRIDES.size === 0) {
  console.warn(
    "[auth] LANTERN_ADMIN_IDS is empty — no account can become admin via login " +
      "(set it to the owner's Google user id, or use an explicit setUserRole)."
  );
}

/**
 * True when ANY sign-in method linked to this profile is an admin override —
 * checking the generic `identities[]` plus the legacy denormalized
 * `patreonId`/`discordId` mirrors (retained for back-compat with older stored
 * profiles). This keeps the owner an admin no matter which provider they sign in
 * with: the profile carries the linked owner identity, so the override applies.
 * Never downgrades — it only elevates to admin when an override id is present.
 */
function profileHasAdminOverride(profile) {
  if (!profile) return false;
  for (const i of profile.identities || []) {
    if (isAdminOverride(i.provider, String(i.providerId))) return true;
  }
  if (profile.patreonId && isAdminOverride("patreon", String(profile.patreonId))) return true;
  if (profile.discordId && isAdminOverride("discord", String(profile.discordId))) return true;
  return false;
}

const PROVIDERS = {
  google: {
    id: "google",
    displayName: "Google",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    usePkce: true,
    extraAuthorizeParams: { access_type: "online", prompt: "select_account" },
    async fetchUser(accessToken) {
      const r = await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error(`Google userinfo failed: ${r.status} ${await r.text()}`);
      const j = await r.json();
      return {
        providerId: j.sub,
        email: j.email || null,
        emailVerified: j.email_verified === true || j.email_verified === "true",
        name: j.name || j.given_name || "",
        avatar: j.picture || null,
      };
    },
    mapRole() {
      return "guest"; // federated identity → free tier by default
    },
  },
};

/** OAuth providers only (excludes the local email/password pseudo-provider). */
function getProvider(id) {
  return PROVIDERS[id] || null;
}

/** Is a provider fully configured (client id + secret present)? */
function isConfigured(id) {
  const p = getProvider(id);
  return !!(p && p.clientId() && p.clientSecret());
}

/**
 * Resolve the effective role for a provider user, applying admin overrides on top
 * of the provider's own mapper.
 */
function resolveRole(provider, user) {
  if (isAdminOverride(provider.id, String(user.providerId))) return "admin";
  let role = provider.mapRole(user) || "guest";
  // Defense in depth: a PROVIDER (a paid tier, a federated login) may NEVER resolve to
  // the operator `admin` role — that comes only from isAdminOverride above (or an
  // explicit setUserRole). Cap any stray `admin` from a mapper down to the top PAID role
  // (`pilot`, $200) — never admin, but don't skip the tier a paid patron earned.
  if (role === "admin") role = "pilot";
  return roleLevel(role) >= 0 ? role : "guest";
}

/**
 * The providers to advertise to the login UI: OAuth providers that are configured,
 * plus `local` when local accounts are enabled (default on).
 */
function listEnabledProviders() {
  const out = [];
  for (const id of ["google"]) {
    if (isConfigured(id)) out.push({ id, displayName: PROVIDERS[id].displayName });
  }
  if (process.env.LANTERN_LOCAL_AUTH !== "0") out.push({ id: "local", displayName: "Email" });
  return out;
}

module.exports = {
  PROVIDERS,
  getProvider,
  isConfigured,
  resolveRole,
  isAdminOverride,
  profileHasAdminOverride,
  listEnabledProviders,
};
