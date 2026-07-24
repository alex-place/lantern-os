/**
 * tenant.js — the ONE multi-tenancy seam (ADR-0018, guardrail W2).
 *
 * Every per-user memory / conversation / profile / key access on a request path
 * should resolve its tenant HERE, so the one Convergence Core serves two delivery
 * profiles (ADR-0018) without a fork:
 *
 *   - "local" (DEFAULT) — desktop / single-owner box. One tenant ("local"); memory
 *     roots at the existing <repoRoot>/data tree; keys come from process.env.
 *     BEHAVIOUR-PRESERVING: with LANTERN_TENANCY unset this returns exactly today's
 *     paths and today's env keys, so 4177 / 4178 / the desktop app are unchanged.
 *   - "cloud" — the multi-tenant hosted origin (GCE, ADR-0018). Tenant = the
 *     authenticated profile id (lib/session-identity.js). Memory roots under
 *     <repoRoot>/data/tenants/<tenantId>; keys come from the per-session key store
 *     only (W6: session-only at launch) — NEVER the ambient process.env, so one
 *     tenant can never spend another tenant's or the host's keys.
 *
 * Selection is by the LANTERN_TENANCY env var ("cloud" → multi-tenant; anything
 * else → local). The funded default model (Gemini via Vertex/ADC) is NOT a
 * per-tenant API key and is resolved elsewhere; resolveKey() here is only for
 * bring-your-own-key providers.
 *
 * This module DEFINES the seam. Routing existing call sites (dreamer-store,
 * conversation-store, the chat key reads in dream-chat.js) through it is a later,
 * separate slice — introducing this file changes no behaviour on its own.
 */

"use strict";

const path = require("path");
const { getSessionUserId } = require("./session-identity");
const appPaths = require("./app-paths");

// Writable-state root. Sourced from lib/app-paths.js (ADR-0014 G2) so the multi-
// tenancy seam and the desktop state-root move share one anchor. On servers this
// is byte-for-byte <repoRoot>/data (UNCHANGED); the desktop launcher relocates it
// to %APPDATA%\unisona\data. `repoRoot` is kept for callers that still reference it.
const repoRoot = appPaths.repoRoot;
const DATA_ROOT = appPaths.dataRoot();
const LOCAL_TENANT_ID = "local";

// provider -> candidate env vars (first hit wins), mirroring lib/dream-chat.js's
// global reads so the local backend is exactly today's behaviour.
const PROVIDER_ENV = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
};

/** Current deployment tenancy profile: "cloud" (multi-tenant) or "local" (default). */
function tenancyProfile() {
  return process.env.LANTERN_TENANCY === "cloud" ? "cloud" : "local";
}

/**
 * Reduce an arbitrary session/profile id to a single SAFE path segment: url-safe
 * chars only (no `.`, `/`, `\`, so no traversal), bounded length. Returns "" for
 * anything that can't be made safe — callers must treat "" as "no tenant".
 */
function safeTenantSegment(id) {
  if (typeof id !== "string") return "";
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
}

/**
 * Data root for a tenant. local -> the existing <repoRoot>/data (UNCHANGED);
 * cloud -> <repoRoot>/data/tenants/<safeId>. Throws in cloud when the id is unsafe
 * or missing — it must NEVER silently fall back to the shared root (that leaks).
 */
function tenantDataRoot(profile, tenantId) {
  if (profile !== "cloud") return DATA_ROOT; // local / desktop: today's tree
  const seg = safeTenantSegment(tenantId);
  if (!seg) throw new Error("tenant_unresolved: cloud profile requires a safe tenant id");
  return path.join(DATA_ROOT, "tenants", seg);
}

/**
 * Resolve a BYO provider key for this request. local -> process.env (today's
 * behaviour); cloud -> per-tenant keys only (W6), never the host env.
 * Both profiles fall back to the persistent per-user encrypted store
 * (lib/user-provider-keys.js, #2505) when nothing earlier matched — in local it
 * ranks BELOW env/vault so owner-funded behaviour is unchanged; in cloud it
 * ranks below the session bag and above nothing (the host env stays excluded).
 * @returns {string|null}
 */
function resolveProviderKey(req, provider, profile) {
  const p = String(provider || "").toLowerCase();
  // Persistent per-user store lookup (both profiles). Session-identity + the
  // store are lazy-required so a failure there can never break env resolution.
  const storedUserKey = () => {
    try {
      const userId = getSessionUserId(req);
      return userId ? require("./user-provider-keys").getKey(userId, p) : null;
    } catch {
      return null;
    }
  };
  if (profile !== "cloud") {
    for (const env of PROVIDER_ENV[p] || []) {
      if (process.env[env]) return process.env[env];
    }
    // Desktop (ADR-0014 G3): fall back to the OS-encrypted vault when no plaintext
    // env key is present. Env still wins, so servers with a .env are byte-for-byte
    // unchanged; the vault is only consulted where a key would otherwise be absent.
    try {
      const vault = require("./key-vault");
      for (const env of PROVIDER_ENV[p] || []) {
        const v = vault.getKey(env);
        if (v) return v;
      }
    } catch {
      /* vault optional — never let a vault error break key resolution */
    }
    return storedUserKey();
  }
  const bag = req && req.session && req.session.tenantKeys;
  return (bag && typeof bag[p] === "string" && bag[p]) || storedUserKey();
}

/**
 * resolveTenant(req) — the seam. Returns a descriptor:
 *   { profile, tenantId, isAuthenticated, dataRoot(), resolveKey(provider) }
 *
 * In the cloud profile an unauthenticated request yields tenantId=null and
 * isAuthenticated=false, and dataRoot() throws — callers MUST gate on
 * isAuthenticated (W3) before touching any per-tenant state.
 */
function resolveTenant(req) {
  const profile = tenancyProfile();

  if (profile !== "cloud") {
    return {
      profile,
      tenantId: LOCAL_TENANT_ID,
      isAuthenticated: true, // the single local owner
      dataRoot: () => tenantDataRoot(profile, LOCAL_TENANT_ID),
      resolveKey: (provider) => resolveProviderKey(req, provider, profile),
    };
  }

  const tenantId = getSessionUserId(req) || null; // profile id, or null if anon
  return {
    profile,
    tenantId,
    isAuthenticated: !!tenantId,
    dataRoot: () => tenantDataRoot(profile, tenantId), // throws when anon (W3)
    resolveKey: (provider) => resolveProviderKey(req, provider, profile),
  };
}

module.exports = {
  resolveTenant,
  tenancyProfile,
  tenantDataRoot,
  safeTenantSegment,
  resolveProviderKey,
  DATA_ROOT,
  LOCAL_TENANT_ID,
  PROVIDER_ENV,
};
