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

// Patreon tier → role by PLEDGE AMOUNT, not campaign-specific tier IDs. The old
// numeric tier IDs were bound to a single campaign ("Dream Journal by Lantern OS"),
// so moving to a new campaign (patreon.com/cw/UnisonaAI) silently broke gating —
// the new campaign's tiers have different IDs. Gating by the dollar amount the
// member is entitled to is campaign-agnostic: any campaign that keeps the same price
// points maps correctly. Thresholds are env-overridable (cents) so a re-pricing is a
// config change, not code.
//
// SECURITY: a PURCHASABLE tier can NEVER grant the operator `admin` role. `admin`
// (role-hierarchy level 3) gates provider-key writes, GPU dispatch, feature flags and
// the /api/accounts console (reset any password, grant admin, delete accounts) — i.e.
// account takeover. Patreon allows custom pledges of any size on a public campaign, so
// mapping a price point to `admin` = "buy site takeover for $X". The top paid tier
// therefore maps to `deep_dreamer` (all paid features incl. trading); real admin comes
// ONLY from LANTERN_ADMIN_IDS (isAdminOverride) or an explicit setUserRole.
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const TIER_CENTS = {
  supporter: num(process.env.PATREON_SUPPORTER_CENTS, 500), // $5  Wanderer
  deep_dreamer: num(process.env.PATREON_DEEP_DREAMER_CENTS, 2000), // $20+ (trading + all paid features; the $200 top tier lands here too)
};

/** Highest PURCHASABLE role for the max pledge amount (cents). Never returns `admin`. */
function roleForAmountCents(maxCents) {
  if (maxCents >= TIER_CENTS.deep_dreamer) return "deep_dreamer";
  if (maxCents >= TIER_CENTS.supporter) return "supporter";
  return null;
}

// Per-provider admin overrides, keyed by "<provider>:<providerId>". The Patreon
// OWNER's user id retains admin regardless of tier. This is account-bound (the
// person's Patreon user id), NOT campaign-bound — so a move to a new Patreon
// ACCOUNT changes it. Set it via LANTERN_ADMIN_IDS (comma-separated). A bare id
// (e.g. "12345678") is interpreted as a PATREON id — "patreon:12345678" — so the
// owner just drops in their Patreon user id; qualify other providers explicitly
// ("google:123"). Keeping the stored key provider-qualified prevents a bare id
// from cross-granting admin to a same-numbered id on a different provider.
const ADMIN_OVERRIDES = new Set(
  String(process.env.LANTERN_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes(":") ? entry : `patreon:${entry}`))
);

function isAdminOverride(provider, providerId) {
  // Strict provider-qualified match. Bare LANTERN_ADMIN_IDS entries were already
  // normalized to "patreon:<id>" at load, so a bare owner id can't cross-grant admin
  // to a same-numbered id on a different provider.
  return ADMIN_OVERRIDES.has(`${provider}:${providerId}`);
}

// Operational guard: with Patreon auth enabled but no admin override, NO ONE can be admin
// (no tier grants it), so the owner is locked out of every admin/staff surface. Warn loudly
// at startup so a fresh deploy doesn't silently ship with an unreachable admin.
if (process.env.PATREON_CLIENT_ID && ADMIN_OVERRIDES.size === 0) {
  console.warn(
    "[auth] Patreon OAuth is configured but LANTERN_ADMIN_IDS is empty — no account can be admin " +
      "(paid tiers never grant admin). Set LANTERN_ADMIN_IDS to the owner's Patreon user id."
  );
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
      // `include=memberships.campaign` is REQUIRED for scoping: with the
      // identity.memberships scope, /identity returns the user's memberships to EVERY
      // creator they back — not just ours — so we must filter to our own campaign or an
      // unrelated pledge would drive (or block) the role. currently_entitled_tiers gives
      // the entitled tier ids; fields[tier]=amount_cents gives the price we gate on.
      const url =
        "https://www.patreon.com/api/oauth2/v2/identity" +
        "?include=memberships.campaign,memberships.currently_entitled_tiers" +
        "&fields%5Btier%5D=title,amount_cents";
      const r = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Patreon userinfo failed: ${r.status} ${await r.text()}`);
      const j = await r.json();
      const { data, included } = j;
      const inc = included || [];
      const members = inc.filter((x) => x.type === "member");
      // Scope to OUR campaign. With a configured PATREON_CAMPAIGN_ID, take only the
      // membership whose campaign matches. Without one, proceed ONLY if there is exactly
      // one membership (unambiguous single-campaign app); if multiple and no id is set we
      // fail CLOSED (no membership => guest) rather than pick an arbitrary campaign.
      const campaignId = process.env.PATREON_CAMPAIGN_ID
        ? String(process.env.PATREON_CAMPAIGN_ID)
        : null;
      let membership = null;
      if (campaignId) {
        membership = members.find((m) => m?.relationships?.campaign?.data?.id === campaignId) || null;
      } else if (members.length === 1) {
        membership = members[0];
      }
      const tierIds =
        membership?.relationships?.currently_entitled_tiers?.data?.map((t) => t.id) || [];
      // Resolve each entitled tier's pledge amount from the included `tier` objects. Treat
      // null AND missing amount_cents identically as "unknown" (dropped) — do not coerce
      // null to 0, which would look like a real $0 tier.
      const tierAttrsById = {};
      for (const x of inc) if (x.type === "tier") tierAttrsById[x.id] = x.attributes || {};
      const entitledAmountsCents = tierIds
        .map((id) => tierAttrsById[id]?.amount_cents)
        .filter((c) => c != null)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      return {
        providerId: data.id,
        email: data.attributes.email || null,
        emailVerified: false, // Patreon does not assert email verification
        name: data.attributes.full_name || "",
        avatar: null,
        tier: tierIds[0] || null,
        memberships: tierIds, // tier ids for OUR campaign (kept for storage/back-compat)
        entitledAmountsCents, // pledge amounts (cents) for OUR campaign — the role source of truth
      };
    },
    mapRole(user) {
      // Gate strictly on PAID amount: a $0 free-tier membership (amount_cents 0) and an
      // entitlement whose amount couldn't be resolved both yield NO paid role. Fail closed
      // to guest rather than grant the default paid `supporter` gate for free.
      const amounts = (user.entitledAmountsCents || []).filter((n) => Number.isFinite(n) && n > 0);
      const maxCents = amounts.length ? Math.max(...amounts) : 0;
      return roleForAmountCents(maxCents) || "guest";
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
  // explicit setUserRole). Cap any stray `admin` from a mapper down to the top paid role.
  if (role === "admin") role = "deep_dreamer";
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
  TIER_CENTS,
  roleForAmountCents,
};
