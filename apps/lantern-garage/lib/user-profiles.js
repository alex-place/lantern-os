/**
 * Local user profile system using CSF-inspired format.
 * Stores per-user profiles, roles, and configuration in JSONL + binary archive.
 * Works entirely offline, no cloud dependency.
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./app-paths");
const crypto = require("crypto");
const { higherRole, STAFF_ROLES } = require("./role-hierarchy");
const { effectiveRole } = require("./stripe-billing");

// Data directory for user profiles. Rooted via app-paths (the #1946 G2 anchor:
// <repoRoot>/data, or UNISONA_STATE_DIR) — NOT process.cwd() (#3088). The old
// process.cwd()-relative path meant a `setUserRole` CLI run from apps/lantern-garage
// wrote a DIFFERENT store than a server launched from the repo root read, so role
// changes silently never took effect and profile data split across two roots.
const PROFILES_DIR = dataPath("profiles");
// #3088 migration aid: if the OLD cwd-relative location still holds data and differs
// from the resolved store, say so at load so the operator can merge/remove it instead
// of silently orphaning accounts. In the documented launch (cwd = repo root) the two
// paths coincide and this is silent.
try {
  const _legacy = path.join(process.cwd(), "data", "profiles");
  if (path.resolve(_legacy) !== path.resolve(PROFILES_DIR) &&
      fs.existsSync(path.join(_legacy, "index.jsonl"))) {
    console.warn(
      `[profiles] store resolves to ${PROFILES_DIR}, but a legacy cwd-relative store still ` +
      `holds data at ${_legacy} (#3088) — merge or remove it so no account is orphaned.`
    );
  }
} catch { /* diagnostic only — never break load */ }
const PROFILES_INDEX = path.join(PROFILES_DIR, "index.jsonl");
const PROFILES_CSF = path.join(PROFILES_DIR, "profiles.csf");
// Append-only Patreon-id <-> Discord-id link store (#697). Latest record wins,
// mirroring the index.jsonl convention. Lets the Discord bot resolve a web role
// from a Discord snowflake (and vice-versa) without a shared DB.
const ACCOUNT_LINKS = path.join(PROFILES_DIR, "account-links.jsonl");

// Ensure directories exist
function ensureDirectories() {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
  }
}

/**
 * Create or update a user profile.
 * Linked to Patreon OAuth user by default, but can be local-only.
 */
function createProfile(userId, data = {}) {
  ensureDirectories();

  const profile = {
    id: userId || crypto.randomBytes(8).toString("hex"),
    name: data.name || "",
    email: data.email || "",
    role: data.role || "guest", // guest, supporter, founder, admin, or custom
    tier: data.tier || null,
    // Per-feature entitlements, independent of the role ladder. Trading is
    // OPT-IN: a paid tier (e.g. Deep Dreamer/founder) does NOT get trade access
    // unless explicitly granted. `admin` is allowed implicitly (see auth-middleware).
    entitlements: { trade: false, ...(data.entitlements || {}) },
    patreonId: data.patreonId || null,
    // ── Dual-source role provenance (ADR: Patreon + Stripe both feed one role) ──
    // The effective `role` above is MAX(patreonRole, stripeRole). We snapshot each
    // source separately so revoking one never over-demotes the other: cancelling a
    // Stripe sub must not strip a Patreon patron's tier, and vice-versa.
    patreonRole: data.patreonRole || null,   // last role Patreon attested (null = never)
    stripeRole: data.stripeRole || null,     // role the active Stripe sub grants (null = none)
    stripeCustomerId: data.stripeCustomerId || null,
    stripeSubscriptionId: data.stripeSubscriptionId || null,
    stripeStatus: data.stripeStatus || null, // last webhook subscription status
    stripeCurrentPeriodEnd: data.stripeCurrentPeriodEnd || null, // unix seconds
    discordId: data.discordId || null, // linked Discord snowflake (#697), if any
    // Provider-agnostic linked identities (ADR-0016). Each entry:
    //   { provider, providerId, email, emailVerified, linkedAt }
    // patreonId/discordId above are kept as denormalized mirrors for backward-compat
    // (the Discord bot + older code read them directly).
    identities: Array.isArray(data.identities) ? data.identities : [],
    // Whether THIS profile's primary email has been verified by a provider that
    // asserts it (Google/Discord). Local sign-ups are unverified until an email
    // verification flow lands. Governs safe auto-linking (ADR-0016).
    emailVerified: data.emailVerified === true,
    // `emailVerified` was ADMITTED without proof (a no-mailer deploy couldn't send a
    // confirmation, see local-auth). Ownership-gated actions — claiming a Stripe
    // subscription by email — must not trust it (#2606). Cleared by a real
    // verification (link click or provider assertion).
    emailAssumed: data.emailAssumed === true,
    // Local email+password credential (scrypt), or null. Never sent to the client;
    // stripped by publicProfile(). Shape: { algo:'scrypt', salt, hash, n, r, p }.
    credential: data.credential || null,
    avatar: data.avatar || null, // URL or base64 avatar
    bio: data.bio || "",
    settings: data.settings || {},
    preferences: {
      theme: data.preferences?.theme || "dark",
      notifications: data.preferences?.notifications !== false,
      emailNotifications: data.preferences?.emailNotifications !== false,
      ...data.preferences,
    },
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
      source: data.source || "local", // 'patreon', 'local', 'oauth', etc.
    },
  };

  // Append to JSONL log
  fs.appendFileSync(PROFILES_INDEX, JSON.stringify(profile) + "\n");

  // Store in memory cache
  updateProfileCache(profile);

  return profile;
}

/**
 * Get a user profile by ID.
 */
function getProfile(userId) {
  ensureDirectories();
  // Read-only: do NOT stamp lastLoginAt here. getProfile runs on nearly every
  // request (gates, billing, tools); mutating the shared CACHED object by reference
  // on each read meant a bogus "last login = now" rode along into the next
  // updateProfile write, and it's simply wrong — reading a profile is not a login
  // (#2626). Real login time is recorded by the session/traction path.
  return loadProfileFromIndex(userId);
}

/**
 * Update user profile.
 */
function updateProfile(userId, updates) {
  const profile = getProfile(userId);
  if (!profile) return null;

  // Merge updates
  const updated = {
    ...profile,
    ...updates,
    id: userId, // Never change the ID
    metadata: {
      ...profile.metadata,
      updatedAt: new Date().toISOString(),
    },
  };

  // Append updated record to JSONL
  fs.appendFileSync(PROFILES_INDEX, JSON.stringify(updated) + "\n");
  updateProfileCache(updated);

  return updated;
}

/**
 * Set user role (admin-only operation).
 */
function setUserRole(userId, newRole) {
  // deep_dreamer is the $20 web tier (renamed from "founder", #698); "founder"
  // stays accepted as a legacy alias so older callers/profiles don't break.
  const validRoles = ["guest", "supporter", "deep_dreamer", "founder", "pilot", "tech_support", "admin"];
  if (!validRoles.includes(newRole)) {
    throw new Error(`Invalid role: ${newRole}`);
  }

  return updateProfile(userId, { role: newRole });
}

/**
 * Set a per-feature entitlement (admin-only operation), e.g. trade access.
 * Merges into the profile's existing entitlements rather than replacing them.
 */
function setEntitlement(userId, key, value) {
  const profile = getProfile(userId);
  if (!profile) return null;
  const entitlements = { ...(profile.entitlements || {}), [key]: !!value };
  return updateProfile(userId, { entitlements });
}

/**
 * Apply a Stripe subscription state change to a profile (the webhook's ONLY write seam).
 *
 * Persists the Stripe snapshot fields and recomputes the effective role as
 * MAX(patreonRole floor, stripeRole) — never demoting a Patreon patron or a staff role.
 * `ai_trader` is set in the SAME write so a Pilot Stripe sub unlocks the autonomous
 * trader and a downgrade removes it, atomically (no second read-modify-write to race).
 *
 * @param {object} patch — any of { stripeRole, status, customerId, subscriptionId,
 *   currentPeriodEnd }. stripeRole===null revokes (drops to the Patreon/base floor).
 *   Fields left undefined are preserved.
 */
function applyStripeState(userId, patch = {}) {
  const profile = getProfile(userId);
  if (!profile) return null;

  // The Patreon/base floor: the role the user has from every NON-Stripe source. Seed it
  // from the current role on first Stripe touch (at that point `role` is entirely
  // non-Stripe, so it IS the floor); thereafter trust the stored snapshot. Staff roles
  // are never lowered below themselves.
  const patreonFloor = profile.patreonRole != null ? profile.patreonRole : (profile.role || "guest");
  const nextStripeRole = patch.stripeRole !== undefined ? patch.stripeRole : (profile.stripeRole || null);

  let nextRole = effectiveRole(patreonFloor, nextStripeRole);
  if (STAFF_ROLES.includes(profile.role)) nextRole = higherRole(profile.role, nextRole);

  // pilot-or-higher (compare via higherRole so we don't depend on an exported level map)
  const isPilotPlus = higherRole(nextRole, "pilot") === nextRole;

  // NEVER persist a staff role into the floor snapshot. Staff preservation is handled
  // LIVE by the STAFF_ROLES guard above (reading profile.role); if we also froze the
  // staff role into patreonRole, a later legitimate setUserRole() demotion would be
  // silently reverted by the next webhook (re-minting admin). Store only a non-staff
  // floor (or keep the prior snapshot / null).
  const patreonFloorSnapshot = STAFF_ROLES.includes(patreonFloor) ? (profile.patreonRole || null) : patreonFloor;
  const updates = {
    role: nextRole,
    patreonRole: patreonFloorSnapshot,
    stripeRole: nextStripeRole,
    entitlements: { ...(profile.entitlements || {}), ai_trader: isPilotPlus },
  };
  if (patch.customerId !== undefined) updates.stripeCustomerId = patch.customerId;
  if (patch.subscriptionId !== undefined) updates.stripeSubscriptionId = patch.subscriptionId;
  if (patch.status !== undefined) updates.stripeStatus = patch.status;
  if (patch.currentPeriodEnd !== undefined) updates.stripeCurrentPeriodEnd = patch.currentPeriodEnd;

  return updateProfile(userId, updates);
}

/** Look up a profile by its Stripe customer id (webhooks arrive keyed by customer).
 *  Uses allProfiles() so a tombstoned account never receives a billing grant (#2608). */
function getProfileByStripeCustomer(customerId) {
  if (!customerId) return null;
  return allProfiles().find((p) => p.stripeCustomerId === customerId) || null;
}

/**
 * List all profiles (admin view).
 */
function listProfiles(filter = {}) {
  // Serve from the in-memory index instead of re-reading + re-parsing the whole JSONL
  // on every call (#2611). The index is authoritative once loaded (all writes update it).
  ensureFullIndex();
  let results = Array.from(profileCache.values());

  if (filter.role) {
    results = results.filter((p) => p.role === filter.role);
  }
  if (filter.source) {
    results = results.filter((p) => p.metadata && p.metadata.source === filter.source);
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    // Null-safe: a record missing name/email must not throw the admin search (#2607).
    results = results.filter(
      (p) =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.email || "").toLowerCase().includes(q) ||
        String(p.id || "").includes(q)
    );
  }

  return results;
}

/**
 * Delete a profile (hard delete).
 */
function deleteProfile(userId) {
  // Keep the tombstone in the in-memory index (do NOT clearProfileCache) so the
  // deleted state stays O(1) for isProfileDeleted / the session gate (#2611, #2608).
  updateProfile(userId, { deleted: true, deletedAt: new Date().toISOString() });
}

/**
 * Export profiles to CSF archive (future: binary format).
 */
function exportToCSF() {
  ensureDirectories();
  // Strip local password credentials — an export/backup must never carry scrypt
  // hashes (security review, ADR-0016). publicProfile() is hoisted below.
  const profiles = listProfiles().map(publicProfile);

  // For now, create a JSON backup that can be converted to binary CSF later
  const csf = {
    format: "CSF-1.0",
    type: "user-profiles",
    timestamp: new Date().toISOString(),
    version: 1,
    records: profiles,
    metadata: {
      totalProfiles: profiles.length,
      roleDistribution: {},
    },
  };

  // Calculate role distribution
  profiles.forEach((p) => {
    csf.metadata.roleDistribution[p.role] =
      (csf.metadata.roleDistribution[p.role] || 0) + 1;
  });

  // Write backup
  fs.writeFileSync(PROFILES_CSF, JSON.stringify(csf, null, 2));

  return csf;
}

/**
 * Import profiles from CSF archive.
 */
function importFromCSF(csfData) {
  if (csfData.format !== "CSF-1.0" || csfData.type !== "user-profiles") {
    throw new Error("Invalid CSF format");
  }

  // Skip tombstones so a round-trip export→import doesn't RESURRECT deleted accounts
  // (#2628). Note: exportToCSF strips password credentials by design, so imported
  // local accounts have no password — they re-authenticate via OAuth or a reset, not
  // via this restore. (A password-preserving backup is a separate, deliberate flow.)
  const live = csfData.records.filter((p) => !p.deleted);
  live.forEach((profile) => {
    createProfile(profile.id, profile);
  });

  return live.length;
}

// ── Internal helpers ──

let profileCache = new Map(); // In-memory index: id -> latest record (incl. tombstones)
let _fullIndexLoaded = false;

/**
 * Load the ENTIRE profiles JSONL into the in-memory index ONCE (#2611). Before this,
 * every login (email lookup), every Stripe webhook (customer lookup), and every
 * list re-read and re-parsed the whole append-only file — which grows with every
 * profile update and would eventually hard-fail auth/billing on read time alone.
 *
 * All writes go through createProfile/updateProfile, which updateProfileCache() the
 * new record, so the index stays authoritative after this initial load. Single
 * writer process per data dir (the dual-boot pair runs from separate worktrees), so
 * no cross-process invalidation is needed — same assumption the cache already made.
 */
function ensureFullIndex() {
  if (_fullIndexLoaded) return;
  ensureDirectories();
  if (fs.existsSync(PROFILES_INDEX)) {
    const lines = fs.readFileSync(PROFILES_INDEX, "utf-8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      try { const p = JSON.parse(line); if (p && p.id) profileCache.set(p.id, p); } catch (e) { /* skip bad line */ }
    }
  }
  _fullIndexLoaded = true;
}

function updateProfileCache(profile) {
  profileCache.set(profile.id, profile);
}

function clearProfileCache(userId) {
  profileCache.delete(userId);
}

function loadProfileFromIndex(userId) {
  // O(1) after the one-time index load — no per-id file rescans (#2611). A tombstoned
  // (deleted) profile resolves to null everywhere it matters — a deleted account must
  // not authenticate, receive billing grants, or reset its password (#2608).
  ensureFullIndex();
  const cached = profileCache.get(userId);
  return cached && !cached.deleted ? cached : null;
}

/**
 * True iff the latest record for this id is a delete tombstone. Distinguishes a
 * DELETED account (deny/lockout) from a simply-missing id, which getProfile can't
 * (both read as null). Used by the session gate and the anti-resurrection guard.
 */
function isProfileDeleted(userId) {
  if (!userId) return false;
  ensureFullIndex();
  const p = profileCache.get(userId);
  return !!(p && p.deleted);
}

// ── Patreon <-> Discord account linking (#697) ──

/**
 * Link a Patreon (web) identity to a Discord snowflake.
 * Appends to the account-links store and stamps discordId onto the profile so a
 * subscriber configured once on the web is resolvable from Discord (and vice-versa).
 * Returns the link record, or null if no profile exists for patreonId.
 */
function linkDiscordAccount(patreonId, discordId) {
  ensureDirectories();
  if (!patreonId || !discordId) {
    throw new Error("linkDiscordAccount requires both patreonId and discordId");
  }
  const profile = loadProfileFromIndex(patreonId);
  if (!profile) return null; // must have a web profile to link to
  const link = {
    patreonId: String(patreonId),
    discordId: String(discordId),
    linkedAt: new Date().toISOString(),
  };
  fs.appendFileSync(ACCOUNT_LINKS, JSON.stringify(link) + "\n");
  // Carry the id on the profile too, so a single profile read exposes the link.
  updateProfile(patreonId, { discordId: String(discordId) });
  return link;
}

/**
 * Return the newest link record for a Discord id (latest-wins), or null.
 */
function getLinkByDiscordId(discordId) {
  ensureDirectories();
  if (!fs.existsSync(ACCOUNT_LINKS)) return null;
  const lines = fs.readFileSync(ACCOUNT_LINKS, "utf-8").split("\n").filter(Boolean);
  let latest = null;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (String(rec.discordId) === String(discordId)) latest = rec;
    } catch (e) { /* skip invalid lines */ }
  }
  return latest;
}

/**
 * Resolve a Discord snowflake to its linked web profile (with role/tier), or null.
 */
function getProfileByDiscordId(discordId) {
  const link = getLinkByDiscordId(discordId);
  if (!link) return null;
  return getProfile(link.patreonId);
}

// ── Provider-agnostic identity, linking, email + local password (ADR-0016) ──

/** All profiles as an array (latest-wins), excluding tombstoned deletes. */
function allProfiles() {
  return listProfiles().filter((p) => !p.deleted);
}

/**
 * Find a profile by a (provider, providerId) identity — checks the generic
 * `identities[]` first, then the legacy denormalized `patreonId`/`discordId`
 * mirrors and the profile `id` itself (old Patreon profiles are keyed by
 * patreonId). Returns the profile or null.
 */
function getProfileByIdentity(provider, providerId) {
  if (!provider || providerId == null) return null;
  const pid = String(providerId);
  for (const p of allProfiles()) {
    if ((p.identities || []).some((i) => i.provider === provider && String(i.providerId) === pid)) return p;
    if (provider === "patreon" && (String(p.patreonId) === pid || String(p.id) === pid)) return p;
    if (provider === "discord" && String(p.discordId) === pid) return p;
  }
  return null;
}

/**
 * Find a profile by email. `verifiedOnly` restricts the match to profiles whose
 * email a provider has verified (`emailVerified === true` or a verified identity
 * with that email) — this is the gate that makes auto-linking safe (ADR-0016).
 */
function getProfileByEmail(email, { verifiedOnly = false } = {}) {
  if (!email) return null;
  const needle = String(email).toLowerCase();
  let fallback = null;
  for (const p of allProfiles()) {
    const rootMatch = p.email && p.email.toLowerCase() === needle;
    const idMatch = (p.identities || []).find((i) => i.email && i.email.toLowerCase() === needle);
    if (!rootMatch && !idMatch) continue;
    const verified = p.emailVerified === true || (idMatch && idMatch.emailVerified === true);
    if (verified) return p; // strongest match wins immediately
    if (!verifiedOnly) fallback = fallback || p;
  }
  return verifiedOnly ? null : fallback;
}

/**
 * Append a provider identity to an existing profile (explicit or auto link).
 * Keeps the legacy denormalized mirrors + account-links.jsonl in sync so the
 * Discord bot and older readers keep working. Returns the updated profile, or
 * null if the profile does not exist.
 */
function linkIdentity(profileId, provider, providerId, email, emailVerified) {
  const profile = loadProfileFromIndex(profileId);
  if (!profile) return null;
  const pid = String(providerId);
  const identities = (profile.identities || []).filter(
    (i) => !(i.provider === provider && String(i.providerId) === pid)
  );
  identities.push({
    provider,
    providerId: pid,
    email: email || null,
    emailVerified: emailVerified === true,
    linkedAt: new Date().toISOString(),
  });
  const updates = { identities };
  // Denormalized mirrors + legacy stores for backward-compat.
  if (provider === "patreon") updates.patreonId = pid;
  if (provider === "discord") {
    updates.discordId = pid;
    // Mirror into account-links.jsonl {patreonId, discordId} that the Python bot
    // (account_link.py — bot migrated to three-doors 2026-07-24) reads directly. `patreonId` here is
    // the canonical profile id (kept named for on-disk/back-compat continuity).
    fs.appendFileSync(
      ACCOUNT_LINKS,
      JSON.stringify({ patreonId: String(profileId), discordId: pid, linkedAt: new Date().toISOString() }) + "\n"
    );
  }
  // If the linked identity is verified, the profile's email becomes verified too
  // (and no longer merely "assumed" — a provider asserted it, #2606).
  if (emailVerified === true && email) {
    updates.emailVerified = true;
    updates.emailAssumed = false;
    if (!profile.email) updates.email = email;
  }
  return updateProfile(profileId, updates);
}

/**
 * Remove a linked provider identity from a profile (ADR-0016). Refuses to remove
 * the account's LAST remaining login method — a profile must always keep at least
 * one way to sign back in (another OAuth identity, or a local password).
 *
 * @returns {{profile}|{error}} updated profile, or an error code
 *   ('unknown_profile' | 'not_linked' | 'last_login_method')
 */
function unlinkIdentity(profileId, provider) {
  const profile = loadProfileFromIndex(profileId);
  if (!profile) return { error: "unknown_profile" };
  const identities = profile.identities || [];
  const has = identities.some((i) => i.provider === provider);
  if (!has) return { error: "not_linked" };

  const remaining = identities.filter((i) => i.provider !== provider);
  // A local password is also a login method even if there is no 'local' identity
  // row, so it counts toward "can still sign in". The field is `credential`, not
  // `passwordHash` — the old name was always undefined, wrongly blocking a
  // password-holder from unlinking their only OAuth provider (#2623).
  const canStillLogIn = remaining.length > 0 || !!profile.credential;
  if (!canStillLogIn) return { error: "last_login_method" };

  const updates = { identities: remaining };
  if (provider === "discord") updates.discordId = null;
  if (provider === "patreon") updates.patreonId = null;
  return { profile: updateProfile(profileId, updates) };
}

/**
 * Get-or-create a profile from ANY OAuth provider identity, applying the
 * ADR-0016 linking policy:
 *   1. Exact identity match (provider, providerId) → return it (idempotent login).
 *   2. Else, if the incoming email is provider-verified AND matches an existing
 *      profile whose email is also verified → AUTO-LINK (append identity).
 *   3. Else → create a fresh profile. (Unverified email collisions do NOT merge —
 *      that is the pre-hijacking defense; those users link explicitly later.)
 *
 * @param provider  'patreon' | 'google' | 'discord'
 * @param u  { providerId, email, emailVerified, name, avatar, tier }
 * @param role  role resolved by the provider's mapper (e.g. Patreon tier → role)
 * @returns { profile, linked, created }
 */
function getOrCreateFromIdentity(provider, u, role) {
  const providerId = String(u.providerId);
  const emailVerified = u.emailVerified === true;

  // 1. Same identity logging in again.
  const existing = getProfileByIdentity(provider, providerId);
  if (existing) {
    // Role resolution is MONOTONIC across linked sign-in methods so a guest-mapping
    // provider (Google/Discord both map to "guest") never clobbers a Patreon-earned tier
    // back to Free on login. EXCEPTION — the tier AUTHORITY (Patreon) re-attesting a
    // NON-staff role re-baselines to the live entitlement, so a lapsed/downgraded paid
    // membership actually loses the paid tier (otherwise pay-once = keep-forever, incl.
    // the trading unlock after a cancellation/chargeback). Staff roles (admin,
    // tech_support) are granted out-of-band (setUserRole / admin-override) and are NEVER
    // demoted by a login; the owner's admin-override is re-applied by the caller.
    //
    // Only re-baseline when the provider read AUTHORITATIVELY resolved the entitlement
    // (u.entitlementResolved). A wrong PATREON_CAMPAIGN_ID or a partial API response yields
    // an EMPTY-but-unresolved read; demoting on that would mass-lock-out paying members, so
    // it's a no-op (keep the existing role) instead of persisting a downgrade to guest.
    const tierAuthorityReattesting =
      provider === "patreon" &&
      !STAFF_ROLES.includes(existing.role || "guest") &&
      u.entitlementResolved === true;
    // Patreon-source role after this login: re-baseline to the live read when the tier
    // authority re-attests, else the monotonic max of prior state + this provider read.
    const patreonNext = tierAuthorityReattesting
      ? role || "guest"
      : higherRole(existing.role || "guest", role || "guest");
    // Fold in any independent Stripe grant so a paid Stripe sub survives a Patreon
    // downgrade (and vice-versa). effectiveRole() whitelists stripeRole, so a bad
    // snapshot can never mint admin here.
    const nextRole = effectiveRole(patreonNext, existing.stripeRole);
    const updates = { role: nextRole, tier: u.tier != null ? u.tier : existing.tier };
    // Snapshot the Patreon-attested role separately (only on an authoritative re-attest)
    // so a later Stripe revoke recomputes MAX(patreonRole, none) instead of dropping the
    // patron to guest. Staff roles are excluded by tierAuthorityReattesting above.
    if (tierAuthorityReattesting) updates.patreonRole = role || "guest";
    if (u.name && !existing.name) updates.name = u.name;
    if (u.avatar && !existing.avatar) updates.avatar = u.avatar;
    if (emailVerified && u.email) {
      updates.emailVerified = true;
      updates.emailAssumed = false; // a provider ASSERTED this address → upgrade from assumed (#2606)
      if (!existing.email) updates.email = u.email;
    }
    // Ensure the identity is recorded even for legacy profiles that predate identities[].
    const hasIdentity = (existing.identities || []).some(
      (i) => i.provider === provider && String(i.providerId) === providerId
    );
    const updated = updateProfile(existing.id, updates);
    if (!hasIdentity) return { profile: linkIdentity(existing.id, provider, providerId, u.email, emailVerified), linked: false, created: false };
    return { profile: updated, linked: false, created: false };
  }

  // 2. Verified-both auto-link.
  if (emailVerified && u.email) {
    const match = getProfileByEmail(u.email, { verifiedOnly: true });
    if (match) {
      return { profile: linkIdentity(match.id, provider, providerId, u.email, true), linked: true, created: false };
    }
  }

  // 3. Fresh profile. Patreon keeps its providerId as the profile id for on-disk
  // continuity with existing index.jsonl records; others get a random id. BUT if
  // that Patreon id was deleted, reusing it would silently void the tombstone
  // (resurrecting the account on re-login, #2608) — so mint a fresh random id
  // instead, leaving the delete intact and giving the returning user a new profile.
  const newId = (provider === "patreon" && !isProfileDeleted(providerId))
    ? providerId
    : crypto.randomBytes(12).toString("hex");
  const profile = createProfile(newId, {
    name: u.name || "",
    email: u.email || "",
    emailVerified,
    role,
    tier: u.tier || null,
    avatar: u.avatar || null,
    patreonId: provider === "patreon" ? providerId : null,
    discordId: provider === "discord" ? providerId : null,
    identities: [
      { provider, providerId, email: u.email || null, emailVerified, linkedAt: new Date().toISOString() },
    ],
    source: provider,
  });
  if (provider === "discord") {
    fs.appendFileSync(
      ACCOUNT_LINKS,
      JSON.stringify({ patreonId: newId, discordId: providerId, linkedAt: new Date().toISOString() }) + "\n"
    );
  }
  return { profile, linked: false, created: true };
}

// ── Local email + password (Node built-in scrypt, zero deps — ADR-0016) ──

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

/** Hash a plaintext password with scrypt. Returns a serializable credential. */
function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(String(plaintext), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString("hex");
  return { algo: "scrypt", salt, hash, n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
}

/**
 * Async, non-blocking verify — same contract as verifyPassword but runs scrypt off
 * the event loop (crypto.scrypt worker) so an unauthenticated login flood can't pin
 * the main thread (#2609). Use on the login hot path; the sync version stays for
 * authenticated one-off callers (change-password).
 */
function verifyPasswordAsync(plaintext, credential) {
  return new Promise((resolve) => {
    if (!credential || credential.algo !== "scrypt" || !credential.salt || !credential.hash) return resolve(false);
    crypto.scrypt(
      String(plaintext),
      credential.salt,
      SCRYPT_KEYLEN,
      { N: credential.n || SCRYPT_N, r: credential.r || SCRYPT_R, p: credential.p || SCRYPT_P },
      (err, derived) => {
        if (err) return resolve(false);
        const stored = Buffer.from(credential.hash, "hex");
        if (stored.length !== derived.length) return resolve(false);
        try { resolve(crypto.timingSafeEqual(stored, derived)); } catch { resolve(false); }
      }
    );
  });
}

/** Constant-time verify a plaintext against a stored scrypt credential. */
function verifyPassword(plaintext, credential) {
  if (!credential || credential.algo !== "scrypt" || !credential.salt || !credential.hash) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(plaintext), credential.salt, SCRYPT_KEYLEN, {
      N: credential.n || SCRYPT_N,
      r: credential.r || SCRYPT_R,
      p: credential.p || SCRYPT_P,
    });
  } catch {
    return false;
  }
  const stored = Buffer.from(credential.hash, "hex");
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

/** Set (or reset) a profile's local password. Returns the updated profile. */
function setLocalPassword(profileId, plaintext) {
  return updateProfile(profileId, { credential: hashPassword(plaintext) });
}

/**
 * Create a local email+password account. Returns { profile } or { error }.
 *
 * SECURITY (ADR-0016 review): if ANY profile already exists for this email we
 * refuse — we do NOT silently attach a password to it. Attaching would let an
 * attacker claim a victim's existing (e.g. Patreon/Google) profile by registering
 * a local password against the same email — an account-takeover / pre-hijacking
 * path. Adding a password to an existing account must instead be an
 * authenticated action from account settings (a follow-up). Local accounts start
 * UNVERIFIED.
 */
function createLocalAccount(email, plaintext, name) {
  if (getProfileByEmail(email)) return { error: "email_taken" };
  const profile = createProfile(crypto.randomBytes(12).toString("hex"), {
    name: name || "",
    email,
    emailVerified: false,
    role: "guest",
    credential: hashPassword(plaintext),
    identities: [{ provider: "local", providerId: String(email).toLowerCase(), email, emailVerified: false, linkedAt: new Date().toISOString() }],
    source: "local",
  });
  return { profile };
}

// Precomputed dummy credential so a login for an unknown email still performs a
// scrypt comparison — equalizes timing and blocks user enumeration by response
// latency (ADR-0016 review).
const _DUMMY_CREDENTIAL = hashPassword(crypto.randomBytes(16).toString("hex"));

/**
 * Verify a local login. Returns the profile on success, or null.
 *
 * Email is NOT a unique key across providers (a verified Google profile and an
 * unverified local one can share an address), so we resolve specifically to the
 * profile that HOLDS a local credential for this email — not just any match. A
 * scrypt comparison always runs (dummy credential when none is found) to keep the
 * timing constant and block user enumeration (ADR-0016 review).
 */
function verifyLocalLogin(email, plaintext) {
  const needle = String(email).toLowerCase();
  let profile = null;
  for (const p of allProfiles()) {
    if (!p.credential) continue;
    const match =
      (p.email && p.email.toLowerCase() === needle) ||
      (p.identities || []).some((i) => i.email && i.email.toLowerCase() === needle);
    if (match) { profile = p; break; }
  }
  const credential = (profile && profile.credential) || _DUMMY_CREDENTIAL;
  const okPassword = verifyPassword(plaintext, credential); // always runs scrypt
  if (!profile) return null;
  return okPassword ? profile : null;
}

/**
 * Async twin of verifyLocalLogin — same enumeration-safe behavior (always runs one
 * scrypt, dummy credential when the email is unknown) but off the event loop (#2609).
 */
async function verifyLocalLoginAsync(email, plaintext) {
  const needle = String(email).toLowerCase();
  let profile = null;
  for (const p of allProfiles()) {
    if (!p.credential) continue;
    const match =
      (p.email && p.email.toLowerCase() === needle) ||
      (p.identities || []).some((i) => i.email && i.email.toLowerCase() === needle);
    if (match) { profile = p; break; }
  }
  const credential = (profile && profile.credential) || _DUMMY_CREDENTIAL;
  const okPassword = await verifyPasswordAsync(plaintext, credential); // always runs scrypt
  if (!profile) return null;
  return okPassword ? profile : null;
}

/**
 * The email address this profile has PROVEN ownership of, or null — the root
 * email when `emailVerified === true`, else the first verified identity email.
 * This is the same trust gate ADR-0016 uses for cross-provider auto-linking,
 * reused for Stripe subscription linking: an UNVERIFIED email must never be able
 * to claim someone else's paid subscription (entitlement theft).
 */
function verifiedEmailOf(profile) {
  if (!profile) return null;
  // An `emailAssumed` root email was admitted WITHOUT proof (a no-mailer deploy
  // couldn't send a confirmation — see local-auth). It must not prove ownership of
  // a Stripe subscription, or an attacker registers a victim's email and claims
  // their sub via /api/billing/link (#2606). A provider-verified identity email
  // (OAuth) or a real link-confirmed root email still counts.
  if (profile.emailVerified === true && profile.emailAssumed !== true && profile.email) return profile.email;
  const hit = (profile.identities || []).find((i) => i.emailVerified === true && i.email);
  return hit ? hit.email : null;
}

/** Strip secrets (credential) before sending a profile to any client. */
function publicProfile(profile) {
  if (!profile) return profile;
  const { credential, ...safe } = profile;
  // Never expose the password hash, but tell the client whether one exists so the
  // settings UI can require the current password (vs. "set a password").
  safe.hasPassword = !!credential;
  return safe;
}

module.exports = {
  createProfile,
  getProfile,
  updateProfile,
  setUserRole,
  setEntitlement,
  applyStripeState,
  getProfileByStripeCustomer,
  listProfiles,
  deleteProfile,
  isProfileDeleted,
  linkDiscordAccount,
  getLinkByDiscordId,
  getProfileByDiscordId,
  exportToCSF,
  importFromCSF,
  // ADR-0016: provider-agnostic identity + local auth
  getProfileByIdentity,
  getProfileByEmail,
  linkIdentity,
  unlinkIdentity,
  getOrCreateFromIdentity,
  hashPassword,
  verifyPassword,
  verifyPasswordAsync,
  setLocalPassword,
  createLocalAccount,
  verifyLocalLogin,
  verifyLocalLoginAsync,
  verifiedEmailOf,
  publicProfile,
};
