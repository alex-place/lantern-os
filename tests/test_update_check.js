/**
 * Regression: server-side update checker replaces the client's 60s api.github.com
 * polling (#879). Tests the pure update logic + the non-blocking snapshot accessor.
 * UPDATE_CHECK_DISABLE=1 keeps the test fully offline (no real GitHub call).
 *
 * Run: node tests/test_update_check.js
 */
"use strict";
process.env.UPDATE_CHECK_DISABLE = "1"; // never touch the network in the test
const assert = require("assert");
const path = require("path");
const { computeUpdate, getUpdateStatus } =
  require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "update-check"));

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

// computeUpdate: an update exists only when the remote differs AND local is strictly
// behind (not ahead — unpushed local commits are not an update).
assert.strictEqual(computeUpdate("a", "a", 0, 0), false);  // same sha
assert.strictEqual(computeUpdate("a", "b", 3, 0), true);   // behind → update
assert.strictEqual(computeUpdate("a", "b", 3, 2), false);  // diverged (ahead too) → no
assert.strictEqual(computeUpdate("a", "b", 0, 0), false);  // differs but not behind
assert.strictEqual(computeUpdate(null, "b", 3, 0), false); // no local
assert.strictEqual(computeUpdate("a", null, 3, 0), false); // no remote
ok("computeUpdate true only when remote differs AND strictly behind (ahead===0)");

// getUpdateStatus is synchronous + non-blocking: returns a snapshot, never awaits the
// network, never throws. With the disable flag it makes zero external calls.
const s = getUpdateStatus(path.join(__dirname, ".."));
assert.strictEqual(typeof s, "object");
for (const k of ["local", "remote", "updateAvailable", "behind", "ahead", "checkedAt"]) {
  assert.ok(k in s, "snapshot has " + k);
}
assert.strictEqual(s.updateAvailable, false, "empty cache → no false-positive banner on first paint");
assert.strictEqual(s.disabled, true, "UPDATE_CHECK_DISABLE=1 reported");
ok("getUpdateStatus returns a non-blocking snapshot; disable flag stops all GitHub calls");

console.log(`\nAll ${passed} update-check assertions passed.`);
