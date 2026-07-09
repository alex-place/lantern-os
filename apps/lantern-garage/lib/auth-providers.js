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
 * `email_verified`, Discord's `verified`). Patreon does not, so its email is
 * always treated as unverified — which, per the linking policy, means it never
 * auto-merges into another account (pre-hijacking defense).
 */

const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const { roleLevel } = require("./role-hierarchy");

// Patreon tier → role (campaign "Dream Journal By Lantern OS"). Kept here so all
// provider-specific role logic lives in the registry.
const PATREON_TIER_TO_ROLE = {
  "28764312": "supporter", // Wanderer ($5)
  "28740619": "deep_dreamer", // Deep Dreamer ($20)
  "28764307": "admin", // Synthesasia Guild ($200)
};

// Per-provider admin overrides, keyed by "<provider>:<providerId>". The Patreon
// owner id retains admin regardless of tier (was OWNER_IDS in patreon-auth.js).
const ADMIN_OVERRIDES = new Set([
  "patreon:49294581",
  ...String(process.env.LANTERN_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

function isAdminOverride(provider, providerId) {
  return ADMIN_OVERRIDES.has(`${provider}:${providerId}`);
}

/**
 * True when ANY sign-in method linked to this profile is an admin override —
 * checking the generic `identities[]` plus the legacy denormalized
 * `patreonId`/`discordId` mirrors. This is what keeps the owner an admin no matter
 * which provider they happen to sign in with: logging in via Google resolves
 * "guest" for the Google identity, but the profile still carries the linked
 * Patreon-owner identity, so the override applies. Never downgrades — it only
 * elevates to admin when an override id is present.
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

  discord: {
    id: "discord",
    displayName: "Discord",
    clientId: () => process.env.DISCORD_CLIENT_ID,
    clientSecret: () => process.env.DISCORD_CLIENT_SECRET,
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scope: "identify email",
    usePkce: true,
    extraAuthorizeParams: { prompt: "consent" },
    async fetchUser(accessToken) {
      const r = await fetchFn("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error(`Discord userinfo failed: ${r.status} ${await r.text()}`);
      const j = await r.json();
      const avatar = j.avatar
        ? `https://cdn.discordapp.com/avatars/${j.id}/${j.avatar}.png`
        : null;
      return {
        providerId: j.id,
        email: j.email || null,
        emailVerified: j.verified === true, // Discord "verified" = email verified
        name: j.global_name || j.username || "",
        avatar,
      };
    },
    mapRole() {
      return "guest";
    },
  },

  patreon: {
    id: "patreon",
    displayName: "Patreon",
    clientId: () => process.env.PATREON_CLIENT_ID,
    clientSecret: () => process.env.PATREON_CLIENT_SECRET,
    authorizeUrl: "https://www.patreon.com/oauth2/authorize",
    tokenUrl: "https://www.patreon.com/api/oauth2/token",
    scope: "identity identity.memberships",
    usePkce: true,
    extraAuthorizeParams: {},
    async fetchUser(accessToken) {
      const url =
        "https://www.patreon.com/api/oauth2/v2/identity" +
        "?include=memberships.currently_entitled_tiers" +
        "&fields%5Btier%5D=title,amount_cents";
      const r = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Patreon userinfo failed: ${r.status} ${await r.text()}`);
      const j = await r.json();
      const { data, included } = j;
      const membership = (included || []).find((x) => x.type === "member");
      const tierIds =
        membership?.relationships?.currently_entitled_tiers?.data?.map((t) => t.id) || [];
      return {
        providerId: data.id,
        email: data.attributes.email || null,
        emailVerified: false, // Patreon does not assert email verification
        name: data.attributes.full_name || "",
        avatar: null,
        tier: tierIds[0] || null,
        memberships: tierIds,
      };
    },
    mapRole(user) {
      for (const tierId of user.memberships || []) {
        if (PATREON_TIER_TO_ROLE[tierId]) return PATREON_TIER_TO_ROLE[tierId];
      }
      return (user.memberships || []).length > 0 ? "supporter" : "guest";
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
  const role = provider.mapRole(user) || "guest";
  return roleLevel(role) >= 0 ? role : "guest";
}

/**
 * The providers to advertise to the login UI: OAuth providers that are configured,
 * plus `local` when local accounts are enabled (default on).
 */
function listEnabledProviders() {
  const out = [];
  for (const id of ["google", "discord", "patreon"]) {
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
  PATREON_TIER_TO_ROLE,
};
