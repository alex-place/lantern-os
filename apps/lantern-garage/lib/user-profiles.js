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
  const profile = loadProfileFromIndex(patreonUser.id);

  if (profile) {
    // Update with latest Patreon data
    return updateProfile(patreonUser.id, {
      name: patreonUser.name,
      email: patreonUser.email,
      patreonId: patreonUser.id,
      tier: patreonUser.primaryTier,
      role: patreonRole, // Use Patreon-mapped role unless overridden locally
      metadata: {
        source: "patreon",
      },
    });
  }

  // Create new profile from Patreon
  return createProfile(patreonUser.id, {
    name: patreonUser.name,
    email: patreonUser.email,
    patreonId: patreonUser.id,
    tier: patreonUser.primaryTier,
    role: patreonRole,
    source: "patreon",
  });
}

/**
 * Export profiles to CSF archive (future: binary format).
 */
function exportToCSF() {
  ensureDirectories();
  const profiles = listProfiles();

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
};
