// user-provider-keys.js (#2505): persistent per-app-user BYOK keys, encrypted at
// rest, plus their fallback rank inside the tenant seam (lib/tenant.js).
// Run: node apps/lantern-garage/test/user-provider-keys.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Hermetic state root: everything this test writes lands in a throwaway tmp dir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "byok-test-"));
process.env.UNISONA_STATE_DIR = TMP;
process.env.LANTERN_KEYSTORE_SECRET = "test-keystore-secret";

const userKeys = require("../lib/user-provider-keys");
const { resolveTenant } = require("../lib/tenant");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const KEY = "byok-unit-fixture-0123456789abcdef";

check("set/get roundtrip returns the exact key", () => {
  userKeys.setKey("user-a", "anthropic", KEY);
  assert.strictEqual(userKeys.getKey("user-a", "anthropic"), KEY);
});

check("value is ENCRYPTED at rest — plaintext never touches disk", () => {
  const file = path.join(TMP, "data", "profiles", "provider-keys", "user-a.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(KEY), "stored file must not contain the plaintext key");
  assert.ok(raw.includes('"iv"') && raw.includes('"tag"'), "AES-GCM envelope expected");
});

check("users are isolated — user-b cannot see user-a's key", () => {
  assert.strictEqual(userKeys.getKey("user-b", "anthropic"), null);
});

check("clearKey removes the key; a second clear is a no-op", () => {
  assert.strictEqual(userKeys.clearKey("user-a", "anthropic"), true);
  assert.strictEqual(userKeys.getKey("user-a", "anthropic"), null);
  assert.strictEqual(userKeys.clearKey("user-a", "anthropic"), false);
});

check("unknown provider and malformed values are rejected", () => {
  assert.throws(() => userKeys.setKey("user-a", "notaprovider", KEY), /unknown_provider/);
  assert.throws(() => userKeys.setKey("user-a", "openai", "short"), /invalid_key_value/);
  assert.throws(() => userKeys.setKey("user-a", "openai", "has spaces in it which is wrong"), /invalid_key_value/);
  // Traversal chars are STRIPPED (same policy as tenant.safeTenantSegment): the
  // write must land inside the store dir, never escape it.
  userKeys.setKey("../../etc/passwd", "openai", KEY);
  assert.ok(fs.existsSync(path.join(TMP, "data", "profiles", "provider-keys", "etcpasswd.json")));
  assert.ok(!fs.existsSync(path.join(TMP, "etc")), "no path escape");
  // An id with NO safe characters at all is unusable → rejected.
  assert.throws(() => userKeys.setKey("!!!", "openai", KEY), /invalid_user_id/);
});

check("listStatus reports set/unset without values", () => {
  userKeys.setKey("user-c", "openai", KEY);
  const rows = userKeys.listStatus("user-c");
  const openai = rows.find((r) => r.provider === "openai");
  const gemini = rows.find((r) => r.provider === "gemini");
  assert.strictEqual(openai.set, true);
  assert.ok(openai.savedAt);
  assert.strictEqual(gemini.set, false);
  assert.ok(!JSON.stringify(rows).includes(KEY));
});

check("a foreign/rotated keystore secret yields null, never garbage or a throw", () => {
  userKeys.setKey("user-d", "xai", KEY);
  process.env.LANTERN_KEYSTORE_SECRET = "a-different-secret";
  assert.strictEqual(userKeys.getKey("user-d", "xai"), null);
  process.env.LANTERN_KEYSTORE_SECRET = "test-keystore-secret";
  assert.strictEqual(userKeys.getKey("user-d", "xai"), KEY);
});

// ── tenant seam integration (#2505) ────────────────────────────────────────
// getSessionUserId reads the test-auth header path; the simplest hermetic session
// is a fake req with the shape session-identity expects.
const { getSessionUserId } = require("../lib/session-identity");

function fakeReq(userId) {
  // session-identity's primary path: an express-session user object.
  return { session: { user: { id: userId } }, headers: {} };
}

check("local profile: process.env still WINS over a stored user key (owner-funded default unchanged)", () => {
  delete process.env.LANTERN_TENANCY;
  userKeys.setKey("user-e", "anthropic", KEY);
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "host.env.fixture";
    assert.strictEqual(resolveTenant(fakeReq("user-e")).resolveKey("anthropic"), "host.env.fixture");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

check("local profile: stored user key fills in when env has nothing", () => {
  delete process.env.LANTERN_TENANCY;
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.strictEqual(getSessionUserId(fakeReq("user-e")), "user-e", "fake req must resolve a session id");
    assert.strictEqual(resolveTenant(fakeReq("user-e")).resolveKey("anthropic"), KEY);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

check("cloud profile: session bag wins; stored key is the fallback; host env is NEVER used (W6)", () => {
  process.env.LANTERN_TENANCY = "cloud";
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "host.env.fixture.must.not.leak";
    const req = fakeReq("user-e");
    req.session.tenantKeys = { anthropic: "session-bag-key" };
    assert.strictEqual(resolveTenant(req).resolveKey("anthropic"), "session-bag-key");
    delete req.session.tenantKeys;
    assert.strictEqual(resolveTenant(req).resolveKey("anthropic"), KEY);
    const anonReq = { session: {}, headers: {} };
    assert.strictEqual(resolveTenant(anonReq).resolveKey("anthropic"), null);
  } finally {
    delete process.env.LANTERN_TENANCY;
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall user-provider-keys tests passed");
