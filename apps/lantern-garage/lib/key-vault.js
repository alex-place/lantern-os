"use strict";

/**
 * key-vault.js — per-user, OS-encrypted secret storage (ADR-0014 desktop Phase-0,
 * guardrail G3).
 *
 * A shipped desktop app must NEVER read provider keys from a plaintext `.env` or
 * an embedded constant. This vault stores each secret encrypted with Windows
 * DPAPI (CurrentUser scope: per-user, machine-bound) and reads it back only inside
 * the owning user's session. The encrypted blob lives at
 * <stateRoot>/keys.vault.json — safe at rest, because DPAPI ciphertext is useless
 * to any other user or on any other machine.
 *
 * DPAPI is Windows-only. On other platforms `setKey` THROWS rather than silently
 * fall back to plaintext (G3: never plaintext, never embedded); `getKey` returns
 * null. macOS Keychain / libsecret backends are a follow-up.
 *
 * Secrets are passed to the PowerShell child via an ENV var, never argv — argv is
 * world-readable in the process list, env is not.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { stateRoot } = require("./app-paths");

function vaultPath(env = process.env) {
  return path.join(stateRoot(env), "keys.vault.json");
}

function readVault(env) {
  try {
    const obj = JSON.parse(fs.readFileSync(vaultPath(env), "utf8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeVault(obj, env) {
  const p = vaultPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 0o600: owner read/write only (belt-and-braces; DPAPI already gates decryption).
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** True only where the DPAPI backend is available. */
function isSupported(platform = process.platform) {
  return platform === "win32";
}

const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-Command"];

/** Encrypt plaintext -> a DPAPI-protected string that only THIS user can decrypt. */
function dpapiProtect(plain) {
  const ps =
    "$s = ConvertTo-SecureString -String $env:VAULT_PLAIN -AsPlainText -Force; " +
    "ConvertFrom-SecureString -SecureString $s";
  return execFileSync("powershell", [...PS_FLAGS, ps], {
    encoding: "utf8",
    env: { ...process.env, VAULT_PLAIN: plain },
  }).trim();
}

/** Decrypt a DPAPI-protected string back to plaintext (same-user only). */
function dpapiUnprotect(protectedStr) {
  const ps =
    "$s = ConvertTo-SecureString -String $env:VAULT_ENC; " +
    "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); " +
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } " +
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
  return execFileSync("powershell", [...PS_FLAGS, ps], {
    encoding: "utf8",
    env: { ...process.env, VAULT_ENC: protectedStr },
  }).replace(/\r?\n$/, "");
}

/**
 * Store a secret under `name`, DPAPI-encrypted. Throws on an unsupported platform
 * (refuses to write plaintext) or invalid input.
 */
function setKey(name, value, env = process.env) {
  if (!isSupported()) {
    throw new Error(
      "key-vault: DPAPI unavailable on this platform — refusing to store a secret in plaintext (G3)"
    );
  }
  if (!name || typeof name !== "string") throw new Error("key-vault: a non-empty name is required");
  if (typeof value !== "string") throw new Error("key-vault: value must be a string");
  const v = readVault(env);
  v[name] = dpapiProtect(value);
  writeVault(v, env);
  return true;
}

/** Read a secret by name, or null if absent / unreadable / unsupported platform. */
function getKey(name, env = process.env) {
  if (!isSupported()) return null;
  const enc = readVault(env)[name];
  if (!enc) return null;
  try {
    return dpapiUnprotect(enc);
  } catch {
    return null; // corrupt blob or decrypted-by-a-different-user — never throw on read
  }
}

/** Names of the secrets currently in the vault (never their values). */
function listKeys(env = process.env) {
  return Object.keys(readVault(env));
}

/** True if a secret is stored under `name` (without decrypting it). */
function hasKey(name, env = process.env) {
  return Object.prototype.hasOwnProperty.call(readVault(env), name);
}

/** Remove a secret. Returns true if it existed. */
function deleteKey(name, env = process.env) {
  const v = readVault(env);
  if (!Object.prototype.hasOwnProperty.call(v, name)) return false;
  delete v[name];
  writeVault(v, env);
  return true;
}

module.exports = { isSupported, setKey, getKey, listKeys, hasKey, deleteKey, vaultPath };
