/**
 * Unit tests for Patreon <-> Discord account linking (#697).
 * Covers linkDiscordAccount / getLinkByDiscordId / getProfileByDiscordId and the
 * profile.discordId stamp.
 *
 * Run: node tests/test_account_link.js
 * No server required. Profile + link writes are isolated to a temp cwd.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// user-profiles resolves data/profiles from process.cwd() at require time, so
// chdir to a fresh temp dir BEFORE requiring it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-link-"));
process.chdir(tmp);

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const profiles = require(path.join(LIB, "user-profiles"));

let passed = 0;
function ok(name) { passed++; console.log("  ✓ " + name); }

// 1. A web profile exists (Deep Dreamer tier).
const p = profiles.getOrCreateFromPatreon(
  { id: "49294581", name: "Dreamer", email: "d@x.io", primaryTier: "Deep Dreamer" },
  "deep_dreamer"
);
assert.strictEqual(p.role, "deep_dreamer");
assert.strictEqual(p.discordId, null);
ok("getOrCreateFromPatreon creates a deep_dreamer profile with no discordId");

// 2. Linking a Discord id writes the store and stamps the profile.
const link = profiles.linkDiscordAccount("49294581", "123456789");
assert.strictEqual(link.patreonId, "49294581");
assert.strictEqual(link.discordId, "123456789");
assert.ok(fs.existsSync(path.join(tmp, "data", "profiles", "account-links.jsonl")));
ok("linkDiscordAccount appends account-links.jsonl and returns the record");

// 3. Resolve the web profile from the Discord id (the cross-system join).
const resolved = profiles.getProfileByDiscordId("123456789");
assert.ok(resolved, "expected a profile for the linked discord id");
assert.strictEqual(resolved.id, "49294581");
assert.strictEqual(resolved.role, "deep_dreamer");
assert.strictEqual(resolved.discordId, "123456789");
ok("getProfileByDiscordId resolves discord id -> web profile + role");

// 4. Unknown Discord id resolves to null.
assert.strictEqual(profiles.getProfileByDiscordId("000"), null);
ok("unknown discord id -> null");

// 5. Re-linking (latest wins) updates the mapping.
profiles.getOrCreateFromPatreon(
  { id: "99999999", name: "Other", email: "o@x.io", primaryTier: "Wanderer" },
  "supporter"
);
profiles.linkDiscordAccount("99999999", "123456789"); // same discord id, new patreon
const relinked = profiles.getProfileByDiscordId("123456789");
assert.strictEqual(relinked.id, "99999999");
ok("re-linking the same discord id resolves to the newest patreon (latest-wins)");

// 6. Linking with no profile returns null (cannot link to a non-existent web user).
assert.strictEqual(profiles.linkDiscordAccount("no-such-user", "555"), null);
ok("linkDiscordAccount with no web profile -> null");

console.log(`\nAll ${passed} account-link assertions passed.`);
