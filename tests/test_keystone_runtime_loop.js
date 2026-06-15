/**
 * Keystone runtime — act→verify loop tests
 *
 * Proves the staff-level contract of keystone-runtime.js:
 *   1. green on first try        → status "success", attempts 1, verified
 *   2. red then fixed            → status "success", attempts 2
 *   3. always red                → status "verification_failed", reverted, !verified
 *   4. snapshot/restore actually reverts the working tree (real temp files)
 *
 * Run: node tests/test_keystone_runtime_loop.js
 */
const assert = require("assert");
const os = require("os");
const fsp = require("fs").promises;
const path = require("path");

const {
  keystoneRun,
  snapshotTargets,
  restoreSnapshots,
} = require("../apps/lantern-garage/lib/keystone-runtime");

// Stub LLM: every call returns a benign "patch" (real apply is stubbed).
const stubLlm = async () => ({ content: "no-op patch" });

function stubTools(verifySeq) {
  let i = 0;
  return {
    searchRepoFiles: async () => [{ path: "x.js", score: 1 }],
    readFileContent: async () => "console.log('x');",
    validatePatch: async () => ({ valid: true }),
    applyPatch: async () => ({
      success: true,
      filesChanged: 1,
      changed: [{ path: "x.js", status: "M" }],
    }),
    runVerification: async () => verifySeq[Math.min(i++, verifySeq.length - 1)],
  };
}

const v = (success, extra = {}) => ({
  ran: true,
  success,
  inconclusive: false,
  output: success ? "ok" : "FAILED: 1 test",
  command: "stub-test",
  ...extra,
});

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`  ✓ ${name}`);
  passed += 1;
}

(async () => {
  console.log("Keystone act→verify loop");

  // 1. green on first try
  let r = await keystoneRun("fix it", "/tmp", stubLlm, {
    maxAttempts: 3,
    tools: stubTools([v(true)]),
  });
  ok("green-first: status success", r.status === "success");
  ok("green-first: attempts === 1", r.attempts === 1);
  ok("green-first: verified", r.verified === true);
  ok("green-first: reports tests green", r.tests && r.tests.success === true);

  // 2. red then fixed on attempt 2
  r = await keystoneRun("fix it", "/tmp", stubLlm, {
    maxAttempts: 3,
    tools: stubTools([v(false), v(true)]),
  });
  ok("red-then-fixed: status success", r.status === "success");
  ok("red-then-fixed: attempts === 2", r.attempts === 2);

  // 3. always red → honest failure + revert (the bug we fixed: never claims success on red)
  r = await keystoneRun("fix it", "/tmp", stubLlm, {
    maxAttempts: 3,
    tools: stubTools([v(false)]),
  });
  ok("always-red: NOT success", r.status !== "success");
  ok("always-red: status verification_failed", r.status === "verification_failed");
  ok("always-red: attempts === 3", r.attempts === 3);
  ok("always-red: verified === false", r.verified === false);
  ok("always-red: reverted === true", r.reverted === true);
  ok("always-red: applied is empty after revert", Array.isArray(r.applied) && r.applied.length === 0);

  // 4. snapshot/restore on real temp files
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ks-"));

  // existing file is restored to original content
  await fsp.writeFile(path.join(tmp, "a.txt"), "ORIGINAL");
  const snaps = new Map();
  await snapshotTargets("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-ORIGINAL\n+CHANGED\n", tmp, snaps);
  await fsp.writeFile(path.join(tmp, "a.txt"), "CHANGED"); // simulate apply
  await restoreSnapshots(snaps, tmp);
  ok("revert: existing file restored", (await fsp.readFile(path.join(tmp, "a.txt"), "utf-8")) === "ORIGINAL");

  // newly-created file is deleted on revert
  const snaps2 = new Map();
  await snapshotTargets("newfile\nb.txt\nHELLO\n", tmp, snaps2);
  await fsp.writeFile(path.join(tmp, "b.txt"), "HELLO"); // simulate create
  await restoreSnapshots(snaps2, tmp);
  let bExists = true;
  try { await fsp.access(path.join(tmp, "b.txt")); } catch { bExists = false; }
  ok("revert: created file removed", bExists === false);

  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} assertions passed.`);
})().catch((e) => {
  console.error("\n✗ TEST FAILED:", e.message);
  process.exit(1);
});
