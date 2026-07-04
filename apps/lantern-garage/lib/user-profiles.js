/**
 * Local user profile system using CSF-inspired format.
 * Stores per-user profiles, roles, and configuration in JSONL + binary archive.
 * Works entirely offline, no cloud dependency.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Data directory for user profiles
const PROFILES_DIR = path.join(process.cwd(), "data", "profiles");
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
  const profile = loadProfileFromIndex(userId);
  if (profile) {
    profile.metadata.lastLoginAt = new Date().toISOString();
    updateProfileCache(profile);
  }
  return profile;
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
  const validRoles = ["guest", "supporter", "deep_dreamer", "founder", "admin"];
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
 * List all profiles (admin view).
 */
function listProfiles(filter = {}) {
  ensureDirectories();
  const profiles = new Map();

  // Read JSONL index and keep latest version of each profile
  if (fs.existsSync(PROFILES_INDEX)) {
    const lines = fs.readFileSync(PROFILES_INDEX, "utf-8").split("\n").filter(Boolean);
    lines.forEach((line) => {
      try {
        const profile = JSON.parse(line);
        profiles.set(profile.id, profile);
      } catch (e) {
        console.error("[PROFILES] Invalid JSON in index:", e.message);
      }
    });
  }

  // Convert to array and filter
  let results = Array.from(profiles.values());

  if (filter.role) {
    results = results.filter((p) => p.role === filter.role);
  }
  if (filter.source) {
    results = results.filter((p) => p.metadata.source === filter.source);
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    results = results.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.id.includes(q)
    );
  }

  return results;
}

/**
 * Delete a profile (hard delete).
 */
function deleteProfile(userId) {
  updateProfile(userId, { deleted: true, deletedAt: new Date().toISOString() });
  clearProfileCache(userId);
}

/**
 * Get or create profile from Patreon OAuth session.
 */
function getOrCreateFromPatreon(patreonUser, patreonRole) {
  // Delegate to the one provider-agnostic path (ADR-0016) so Patreon logins take
  // the same linking route as Google/Discord. Patreon email is treated as
  // UNVERIFIED (Patreon does not assert email_verified), so it never auto-links.
  const { profile } = getOrCreateFromIdentity(
    "patreon",
    {
      providerId: patreonUser.id,
      email: patreonUser.email,
      emailVerified: false,
      name: patreonUser.name,
      tier: patreonUser.primaryTier,
    },
    patreonRole
  );
  return profile;
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

  csfData.records.forEach((profile) => {
    createProfile(profile.id, profile);
  });

  return csfData.records.length;
}

// ── Internal helpers ──

let profileCache = new Map(); // In-memory cache for performance

function updateProfileCache(profile) {
  profileCache.set(profile.id, profile);
}

function clearProfileCache(userId) {
  profileCache.delete(userId);
}

function loadProfileFromIndex(userId) {
  // Check cache first
  if (profileCache.has(userId)) {
    return profileCache.get(userId);
  }

  ensureDirectories();

  // Read JSONL and find latest version
  if (!fs.existsSync(PROFILES_INDEX)) {
    return null;
  }

  const lines = fs.readFileSync(PROFILES_INDEX, "utf-8").split("\n").filter(Boolean);
  let latest = null;

  for (const line of lines) {
    try {
      const profile = JSON.parse(line);
      if (profile.id === userId) {
        latest = profile;
      }
    } catch (e) {
      // Skip invalid lines
    }
  }

  if (latest) {
    updateProfileCache(latest);
  }

  return latest;
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
    // (src/discord_lounge_bot/account_link.py) reads directly. `patreonId` here is
    // the canonical profile id (kept named for on-disk/back-compat continuity).
    fs.appendFileSync(
      ACCOUNT_LINKS,
      JSON.stringify({ patreonId: String(profileId), discordId: pid, linkedAt: new Date().toISOString() }) + "\n"
    );
  }
  // If the linked identity is verified, the profile's email becomes verified too.
  if (emailVerified === true && email) {
    updates.emailVerified = true;
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
  // A local password (passwordHash) is also a login method even if there is no
  // 'local' identity row, so it counts toward "can still sign in".
  const canStillLogIn = remaining.length > 0 || !!profile.passwordHash;
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
    const updates = { role, tier: u.tier != null ? u.tier : existing.tier };
    if (u.name && !existing.name) updates.name = u.name;
    if (u.avatar && !existing.avatar) updates.avatar = u.avatar;
    if (emailVerified && u.email) {
      updates.emailVerified = true;
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
  // continuity with existing index.jsonl records; others get a random id.
  const newId = provider === "patreon" ? providerId : crypto.randomBytes(12).toString("hex");
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

/** Strip secrets (credential) before sending a profile to any client. */
function publicProfile(profile) {
  if (!profile) return profile;
  const { credential, ...safe } = profile;
  return safe;
}

module.exports = {
  createProfile,
  getProfile,
  updateProfile,
  setUserRole,
  setEntitlement,
  listProfiles,
  deleteProfile,
  getOrCreateFromPatreon,
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
  setLocalPassword,
  createLocalAccount,
  verifyLocalLogin,
  publicProfile,
};
