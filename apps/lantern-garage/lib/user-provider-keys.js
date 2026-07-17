"use strict";

/**
 * user-provider-keys.js — persistent, per-APP-USER BYOK provider keys (#2505).
 *
 * This is the store behind POST/DELETE /api/providers/set-key and the tenant
 * seam's persistent fallback (lib/tenant.js resolveProviderKey). It is distinct
 * from the two stores that already exist:
 *   - process.env / Windows User env  — the HOST OWNER's keys (admin-only routes)
 *   - lib/key-vault.js (DPAPI)        — the desktop OS-user's keys, one per machine
 * Neither can hold keys for many signed-in web users at once; this store can.
 *
 * At-rest format: data/profiles/provider-keys/<safeUserId>.json, one file per
 * user, each key AES-256-GCM encrypted (unique IV per write, auth tag stored).
 * The AES key is scrypt-derived from LANTERN_KEYSTORE_SECRET when set, else the
 * session-signing secret (lib/session-secret.js) — which fails closed in any
 * non-local deploy, so ciphertext there is never protected by the committed dev
 * default. Values are never logged and never returned unmasked by any route.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const appPaths = require("./app-paths");
const { resolveSessionSecret } = require("./session-secret");

// The BYOK providers a user may store a key for. Kept deliberately narrower than
// the host-env allowlist in routes/providers.js: these are the four the settings
// page (settings.html) offers.
const BYOK_PROVIDERS = ["anthropic", "openai", "gemini", "xai"];

const SCRYPT_SALT = "unisona-byok-keystore-v1"; // versioned; bump on format change
let _cache = { secret: null, key: null }; // scrypt is slow — memoize per secret

function storeDir(env = process.env) {
  return path.join(appPaths.dataRoot(env), "profiles", "provider-keys");
}

/** Same policy as tenant.safeTenantSegment: url-safe chars, bounded, "" = unusable. */
function safeUserSegment(id) {
  if (typeof id !== "string") return "";
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
}

function aesKey(env = process.env) {
  const secret = env.LANTERN_KEYSTORE_SECRET || resolveSessionSecret(env);
  if (_cache.secret !== secret) {
    _cache = { secret, key: crypto.scryptSync(secret, SCRYPT_SALT, 32) };
  }
  return _cache.key;
}

function userFile(userId, env) {
  const seg = safeUserSegment(userId);
  if (!seg) throw new Error("invalid_user_id");
  return path.join(storeDir(env), seg + ".json");
}

function readUserRecord(userId, env) {
  try {
    const obj = JSON.parse(fs.readFileSync(userFile(userId, env), "utf8"));
    return obj && typeof obj === "object" && obj.keys ? obj : { v: 1, keys: {} };
  } catch {
    return { v: 1, keys: {} };
  }
}

function writeUserRecord(userId, record, env) {
  const p = userFile(userId, env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 0o600 belt-and-braces on POSIX; on Windows the DACL follows the parent dir.
  fs.writeFileSync(p, JSON.stringify(record, null, 2), { mode: 0o600 });
}

function assertProvider(provider) {
  const p = String(provider || "").toLowerCase();
  if (!BYOK_PROVIDERS.includes(p)) throw new Error("unknown_provider");
  return p;
}

function encrypt(plain, env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(env), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function decrypt(entry, env) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(env), Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
}

/** Persist one provider key for one user (encrypted). Throws on bad input. */
function setKey(userId, provider, value, env = process.env) {
  const p = assertProvider(provider);
  const v = String(value || "").trim();
  // Provider keys are single-line ASCII tokens; reject anything else before it
  // can reach disk (or, later, an Authorization header).
  if (v.length < 8 || v.length > 512 || /[^\x21-\x7e]/.test(v)) throw new Error("invalid_key_value");
  const record = readUserRecord(userId, env);
  record.keys[p] = { ...encrypt(v, env), savedAt: new Date().toISOString() };
  writeUserRecord(userId, record, env);
}

/** Remove one provider key for one user. No-op when absent. */
function clearKey(userId, provider, env = process.env) {
  const p = assertProvider(provider);
  const record = readUserRecord(userId, env);
  if (!record.keys[p]) return false;
  delete record.keys[p];
  writeUserRecord(userId, record, env);
  return true;
}

/** Decrypted key for one user+provider, or null. Never logs; never throws on a
 *  corrupt/foreign-secret entry (returns null — the caller treats it as unset). */
function getKey(userId, provider, env = process.env) {
  let p;
  try {
    p = assertProvider(provider);
  } catch {
    return null;
  }
  if (!safeUserSegment(userId)) return null;
  const entry = readUserRecord(userId, env).keys[p];
  if (!entry) return null;
  try {
    return decrypt(entry, env);
  } catch {
    return null; // wrong keystore secret or tampered file — treat as unset
  }
}

/** Masked status for the settings UI: which providers have a stored key. */
function listStatus(userId, env = process.env) {
  const record = safeUserSegment(userId) ? readUserRecord(userId, env) : { keys: {} };
  return BYOK_PROVIDERS.map((p) => ({
    provider: p,
    set: !!record.keys[p],
    savedAt: record.keys[p]?.savedAt || null,
  }));
}

module.exports = { BYOK_PROVIDERS, setKey, clearKey, getKey, listStatus };
