/**
 * Regression test for reserved-key handling in the feature-flag store.
 *
 * normalizeKey() lowercases a flag key and strips it to [a-z0-9._-], but it used
 * to let the JS reserved names "__proto__", "constructor" and "prototype" pass
 * through unchanged. setFlag("__proto__", …) then validated fine and the route
 * returned { ok:true, flag:{…} }, yet `cfg.flags["__proto__"] = {…}` hits the
 * prototype setter and stores nothing — so the flag never appears in listFlags()
 * / getPublicFlags(). The endpoint reported success while silently no-op'ing.
 *
 * The fix makes normalizeKey() reject the reserved names (returns ""), so
 * setFlag()'s `if (!k) throw` produces a clean 400 instead, and the flags map is
 * prototype-less as belt-and-suspenders. This test asserts each reserved key is
 * rejected and that a normal key still normalizes and round-trips through
 * setFlag()/listFlags().
 *
 * Run: node tests/test_feature_flags_reserved_keys.js   (no server required)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const {
  normalizeKey,
  setFlag,
  deleteFlag,
  listFlags,
  isFlagEnabled,
  STORE_PATH,
  _resetCache,
} = require(LIB + "/feature-flags");

let passed = 0;
const say = (line) => process.stdout.write(line + "\n");
function ok(name) { passed++; say("  ✓ " + name); }

const RESERVED = ["__proto__", "constructor", "prototype"];

// Round-tripping a normal key calls saveConfig(), which writes the real store.
// Back it up and restore in finally so the test never clobbers admin config.
const BACKUP = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH) : null;
const TEST_KEY = "test-reserved-keys.regression";

try {
  _resetCache();

  // --- normalizeKey rejects each reserved name (case / whitespace / junk too) ---
  for (const k of RESERVED) {
    assert.strictEqual(normalizeKey(k), "", `${k} should normalize to ""`);
    ok(`normalizeKey("${k}") rejected`);
  }
  assert.strictEqual(normalizeKey("  __PROTO__ "), "", "case+whitespace variant rejected");
  assert.strictEqual(normalizeKey("Constructor!!"), "", "stripped-to-reserved rejected");
  ok("reserved names rejected after lowercasing/stripping");

  // --- setFlag throws a clean error for reserved keys (writes nothing) ---
  for (const k of RESERVED) {
    assert.throws(
      () => setFlag(k, { enabled: true }),
      /flag key is required/,
      `setFlag("${k}") should throw the empty-key error`
    );
    ok(`setFlag("${k}") → throws (no silent success)`);
  }

  // The reserved-key writes must not have landed anywhere observable.
  const keysAfter = listFlags().map((f) => f.key);
  for (const k of RESERVED) {
    assert.ok(!keysAfter.includes(k), `${k} must not appear in listFlags()`);
    assert.strictEqual(isFlagEnabled(k), false, `${k} must read as disabled`);
  }
  ok("no reserved key leaked into listFlags()/isFlagEnabled()");

  // --- and no global prototype pollution as a side effect ---
  assert.strictEqual({}.enabled, undefined, "Object.prototype must be clean");
  ok("Object.prototype not polluted");

  // --- a normal key still normalizes and round-trips through setFlag ---
  assert.strictEqual(normalizeKey("Test-Reserved-Keys.Regression"), TEST_KEY);
  const rec = setFlag("Test-Reserved-Keys.Regression", { enabled: true }, "test");
  assert.strictEqual(rec.key, TEST_KEY, "setFlag returns the normalized key");
  assert.strictEqual(rec.enabled, true);
  assert.ok(listFlags().some((f) => f.key === TEST_KEY), "normal flag is listed");
  assert.strictEqual(isFlagEnabled(TEST_KEY), true, "normal flag reads enabled");
  ok("normal key normalizes + round-trips through setFlag/listFlags");

  deleteFlag(TEST_KEY);
  assert.ok(!listFlags().some((f) => f.key === TEST_KEY), "test flag cleaned up");
  ok("deleteFlag removes the test flag");

  say(`\nAll ${passed} feature-flag reserved-key assertions passed.`);
} finally {
  // Restore the real store byte-for-byte and drop the mutated cache.
  if (BACKUP !== null) fs.writeFileSync(STORE_PATH, BACKUP);
  else if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  _resetCache();
}
