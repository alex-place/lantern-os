// desktop-phase0.test.js — ADR-0014 desktop Phase-0 hardening seams:
//   1. lib/app-paths.js    — writable-state relocation (G2)
//   2. lib/key-vault.js    — DPAPI-encrypted key storage (G3)
//   3. lib/request-auth.js — loopback ≠ admin, per-boot local token (G4)
//
// All three are BEHAVIOUR-PRESERVING by default: with none of UNISONA_DESKTOP /
// UNISONA_STATE_DIR / UNISONA_LOCAL_TOKEN set, the Core behaves exactly as today.
// Run: node apps/lantern-garage/test/desktop-phase0.test.js
"use strict";

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const appPaths = require("../lib/app-paths");
const vault = require("../lib/key-vault");
const auth = require("../lib/request-auth");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL-", name, "\n      ", e.message);
  }
}

// ── Pillar 1: app-paths (state relocation) ──────────────────────────────────
const REPO_DATA = path.join(appPaths.repoRoot, "data");

check("default profile roots state at <repoRoot>/data (byte-for-byte, no regression)", () => {
  const env = {}; // nothing set
  assert.strictEqual(appPaths.isDesktop(env), false);
  assert.strictEqual(appPaths.stateRoot(env), appPaths.repoRoot);
  assert.strictEqual(appPaths.dataRoot(env), REPO_DATA);
});

check("UNISONA_DESKTOP=1 relocates state to %APPDATA%/unisona on Windows", () => {
  const env = { UNISONA_DESKTOP: "1", APPDATA: "C:\\Users\\t\\AppData\\Roaming" };
  assert.strictEqual(appPaths.isDesktop(env), true);
  assert.strictEqual(appPaths.stateRoot(env, "win32"), path.join(env.APPDATA, "unisona"));
  assert.strictEqual(appPaths.dataRoot(env, "win32"), path.join(env.APPDATA, "unisona", "data"));
});

check("desktop uses XDG/Library on Linux/macOS", () => {
  const linux = { UNISONA_DESKTOP: "1", XDG_DATA_HOME: "/home/t/.local/share" };
  assert.strictEqual(appPaths.stateRoot(linux, "linux"), path.join("/home/t/.local/share", "unisona"));
  const mac = { UNISONA_DESKTOP: "1" };
  assert.ok(appPaths.stateRoot(mac, "darwin").endsWith(path.join("Application Support", "unisona")));
});

check("UNISONA_STATE_DIR overrides everything (portable / test installs)", () => {
  const env = { UNISONA_STATE_DIR: path.join(os.tmpdir(), "unisona-portable") };
  assert.strictEqual(appPaths.isDesktop(env), true);
  assert.strictEqual(appPaths.stateRoot(env), path.resolve(env.UNISONA_STATE_DIR));
  assert.strictEqual(appPaths.dataRoot(env), path.join(path.resolve(env.UNISONA_STATE_DIR), "data"));
});

check("tenant.js DATA_ROOT is sourced from app-paths (shared anchor)", () => {
  const tenant = require("../lib/tenant");
  assert.strictEqual(tenant.DATA_ROOT, appPaths.dataRoot());
  assert.strictEqual(tenant.DATA_ROOT, REPO_DATA); // default profile → unchanged
});

// ── Pillar 2: key-vault (DPAPI) ─────────────────────────────────────────────
check("isSupported is true only on win32", () => {
  assert.strictEqual(vault.isSupported("win32"), true);
  assert.strictEqual(vault.isSupported("linux"), false);
  assert.strictEqual(vault.isSupported("darwin"), false);
});

check("vault path lives under the state root", () => {
  const env = { UNISONA_STATE_DIR: path.join(os.tmpdir(), "unisona-vault-path") };
  assert.strictEqual(vault.vaultPath(env), path.join(path.resolve(env.UNISONA_STATE_DIR), "keys.vault.json"));
});

if (process.platform === "win32") {
  check("DPAPI round-trip: setKey then getKey returns the secret; blob is not plaintext", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unisona-vault-"));
    const env = { UNISONA_STATE_DIR: dir };
    const secret = "sk-test-" + "x".repeat(32);
    vault.setKey("ANTHROPIC_API_KEY", secret, env);
    assert.strictEqual(vault.hasKey("ANTHROPIC_API_KEY", env), true);
    assert.deepStrictEqual(vault.listKeys(env), ["ANTHROPIC_API_KEY"]);
    // On-disk blob must be DPAPI ciphertext, never the plaintext secret.
    const raw = fs.readFileSync(vault.vaultPath(env), "utf8");
    assert.ok(!raw.includes(secret), "vault file must not contain the plaintext secret");
    assert.strictEqual(vault.getKey("ANTHROPIC_API_KEY", env), secret);
    assert.strictEqual(vault.deleteKey("ANTHROPIC_API_KEY", env), true);
    assert.strictEqual(vault.getKey("ANTHROPIC_API_KEY", env), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
} else {
  check("non-win32: getKey returns null and setKey refuses (never plaintext, G3)", () => {
    assert.strictEqual(vault.getKey("ANTHROPIC_API_KEY", {}), null);
    assert.throws(() => vault.setKey("ANTHROPIC_API_KEY", "x", {}), /DPAPI unavailable/);
  });
}

// ── Pillar 3: request-auth (loopback ≠ admin) ───────────────────────────────
const loopback = () => ({ socket: { remoteAddress: "127.0.0.1" }, headers: {} });
const withHeader = (name, val) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { [name]: val } });
const proxied = () => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "9.9.9.9" } });
const remote = () => ({ socket: { remoteAddress: "203.0.113.5" }, headers: {} });

check("default (no tokens): loopback trusted, proxied/remote not (server behaviour unchanged)", () => {
  const env = {};
  assert.strictEqual(auth.isOperatorRequest(loopback(), env), true);
  assert.strictEqual(auth.isOperatorRequest(proxied(), env), false);
  assert.strictEqual(auth.isOperatorRequest(remote(), env), false);
});

check("OPERATOR_TOKEN: remote caller trusted only with the matching header", () => {
  const env = { OPERATOR_TOKEN: "s3cret-token-value" };
  assert.strictEqual(auth.isOperatorRequest(remote(), env), false);
  const ok = { socket: { remoteAddress: "203.0.113.5" }, headers: { "x-operator-token": "s3cret-token-value" } };
  const bad = { socket: { remoteAddress: "203.0.113.5" }, headers: { "x-operator-token": "wrong" } };
  assert.strictEqual(auth.isOperatorRequest(ok, env), true);
  assert.strictEqual(auth.isOperatorRequest(bad, env), false);
});

check("UNISONA_LOCAL_TOKEN: loopback ALONE is NO LONGER admin (the G4 hardening)", () => {
  const env = { UNISONA_LOCAL_TOKEN: "boot-token-abc123" };
  // A bare loopback hit (or a local CSRF/DNS-rebind page) is now rejected.
  assert.strictEqual(auth.isOperatorRequest(loopback(), env), false);
  // Only a request carrying the launcher-minted token is trusted.
  assert.strictEqual(auth.isOperatorRequest(withHeader("x-operator-token", "boot-token-abc123"), env), true);
  assert.strictEqual(auth.isOperatorRequest(withHeader("x-unisona-token", "boot-token-abc123"), env), true);
  assert.strictEqual(auth.isOperatorRequest(withHeader("x-operator-token", "boot-token-WRONG"), env), false);
});

check("tokensEqual is length-checked and rejects empties", () => {
  assert.strictEqual(auth.tokensEqual("abc", "abc"), true);
  assert.strictEqual(auth.tokensEqual("abc", "abcd"), false);
  assert.strictEqual(auth.tokensEqual("", ""), false);
  assert.strictEqual(auth.tokensEqual("x", undefined), false);
});

// ── Result ──────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\ndesktop-phase0: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ndesktop-phase0: all checks passed");
