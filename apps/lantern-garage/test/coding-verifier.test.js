// coding-verifier.test.js — #2174: verification-decides layer. A VERIFIER, not a
// model vote, judges a held proposal: entailment (patch-consistency + optional
// MiniCheck) + tests-run (real execution against the proposal, sandboxed with a
// scoped restore). The verdict fills receipt.test; apply is blocked on an
// enforced, decisive failure.
// Run: node apps/lantern-garage/test/coding-verifier.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cb = require("../lib/coding-backend");
const verifier = require("../lib/coding-backend/verifier");
const entailment = require("../lib/coding-backend/verifiers/entailment");
const testsRun = require("../lib/coding-backend/verifiers/tests-run");
const router = require("../lib/coding-backend/router");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL-", name, "\n      ", e.stack || e.message);
  }
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kb-vf-"));
}
// A fixture repo whose `checkExpr` (a node snippet) decides pass/fail. It reads
// feature.js if present. Exit 0 = pass, 1 = fail.
function fixtureRepo(checkBody) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "check.js"), checkBody);
  return dir;
}

(async () => {
  // ── entailment: patch-consistency ────────────────────────────────────────
  await check("patch-consistency PASSES when every added line is in the proposed content", () => {
    const files = [{ path: "a.js", content: "const x = 42;\nmodule.exports = x;\n" }];
    const patchPreview = "+++ b/a.js\n+const x = 42;\n+module.exports = x;";
    const r = entailment.patchConsistency({ files, patchPreview });
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.decisive, false, "a passing guard is NOT decisive");
  });

  await check("patch-consistency FAILS (decisive) on a hallucinated added line", () => {
    const files = [{ path: "a.js", content: "const x = 42;\n" }];
    const patchPreview = "+++ b/a.js\n+const x = 42;\n+deleteAllProductionData();"; // never in content
    const r = entailment.patchConsistency({ files, patchPreview });
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.decisive, true, "a hallucinated diff is a decisive failure");
    assert(r.evidence.missingCount >= 1);
  });

  await check("minicheck is SKIPPED when no MINICHECK_ENDPOINT (interface real, model optional)", async () => {
    const r = await entailment.minicheck({ files: [{ path: "a", content: "x" }], task: "t", patchPreview: "" }, {});
    assert.strictEqual(r.skipped, true);
    assert(/MINICHECK_ENDPOINT/.test(r.reason));
  });

  // ── tests-run: real execution + sandboxed restore ────────────────────────
  await check("tests-run RUNS the repo tests against the proposal and PASSES; restores the tree", async () => {
    const repo = fixtureRepo(
      "const fs=require('fs');const s=fs.existsSync('./feature.js')?fs.readFileSync('./feature.js','utf8'):'';process.exit(s.includes('ANSWER=42')?0:1);"
    );
    fs.writeFileSync(path.join(repo, "existing.txt"), "ORIG");
    const files = [
      { path: "feature.js", content: "// ANSWER=42\nmodule.exports = 42;\n" }, // new file
      { path: "existing.txt", content: "CHANGED" }, // overwrite existing
    ];
    const r = await testsRun.runTests({ repoPath: repo, files }, { testCommand: "node check.js" });
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.passed, true, "check.js sees ANSWER=42 while materialised");
    assert.strictEqual(r.decisive, true);
    // sandbox restore: new file gone, existing file back to ORIG
    assert(!fs.existsSync(path.join(repo, "feature.js")), "new file removed after run");
    assert.strictEqual(fs.readFileSync(path.join(repo, "existing.txt"), "utf8"), "ORIG", "existing file restored");
  });

  await check("tests-run FAILS when the proposal doesn't satisfy the tests (decisive)", async () => {
    const repo = fixtureRepo(
      "const fs=require('fs');const s=fs.existsSync('./feature.js')?fs.readFileSync('./feature.js','utf8'):'';process.exit(s.includes('ANSWER=42')?0:1);"
    );
    const files = [{ path: "feature.js", content: "module.exports = 0;\n" }]; // no ANSWER=42
    const r = await testsRun.runTests({ repoPath: repo, files }, { testCommand: "node check.js" });
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.decisive, true);
    assert.strictEqual(r.evidence.exitCode, 1);
    assert(!fs.existsSync(path.join(repo, "feature.js")), "tree restored even on failure");
  });

  await check("tests-run is SKIPPED when no test command can be detected", async () => {
    const repo = tmp(); // no package.json, no explicit command
    const r = await testsRun.runTests({ repoPath: repo, files: [{ path: "x.js", content: "1" }] }, {});
    assert.strictEqual(r.skipped, true);
    assert(!fs.existsSync(path.join(repo, "x.js")), "no file left behind when skipped");
  });

  await check("detectTestCommand: real scripts.test → npm test; placeholder / missing → null", () => {
    const good = tmp();
    fs.writeFileSync(path.join(good, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
    assert.deepStrictEqual(testsRun.detectTestCommand(good).argv, ["npm", "test", "--silent"]);
    const placeholder = tmp();
    fs.writeFileSync(path.join(placeholder, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.strictEqual(testsRun.detectTestCommand(placeholder), null);
    assert.strictEqual(testsRun.detectTestCommand(tmp()), null, "no package.json → null");
  });

  // ── verifier orchestration + policy ──────────────────────────────────────
  await check("verifyProposal default (guard only) → passed:null, decisive:false (not enough to claim success)", async () => {
    const files = [{ path: "a.js", content: "const x=1;\n" }];
    const v = await verifier.verifyProposal({ files, patchPreview: "+++ b/a.js\n+const x=1;" }, {});
    assert.strictEqual(v.passed, null);
    assert.strictEqual(v.decisive, false);
    assert.strictEqual(v.enforce, false);
  });

  await check("verifyProposal with runTests+passing → passed:true, decisive:true", async () => {
    const repo = fixtureRepo("process.exit(0);");
    const v = await verifier.verifyProposal(
      { repoPath: repo, files: [{ path: "a.js", content: "1" }], patchPreview: "+++ b/a.js\n+1" },
      { runTests: true, testCommand: "node check.js" }
    );
    assert.strictEqual(v.passed, true);
    assert.strictEqual(v.decisive, true);
    assert(v.evidence.ran.includes("tests-run"));
  });

  await check("verifyProposal: a hallucinated diff is a decisive FAIL even with tests off", async () => {
    const v = await verifier.verifyProposal(
      { files: [{ path: "a.js", content: "safe();" }], patchPreview: "+++ b/a.js\n+rm -rf /" },
      {}
    );
    assert.strictEqual(v.passed, false);
    assert.strictEqual(v.decisive, true);
    assert(v.evidence.failed.includes("patch-consistency"));
  });

  await check("isBlocked only for an enforced, decisive failure", () => {
    assert.strictEqual(verifier.isBlocked({ enforce: true, decisive: true, passed: false }), true);
    assert.strictEqual(verifier.isBlocked({ enforce: false, decisive: true, passed: false }), false, "advisory: not blocked");
    assert.strictEqual(verifier.isBlocked({ enforce: true, decisive: false, passed: null }), false, "undecisive: not blocked");
    assert.strictEqual(verifier.isBlocked({ enforce: true, decisive: true, passed: true }), false);
  });

  // ── end-to-end through the control plane ─────────────────────────────────
  await check("runCodingTask stamps the verifier verdict onto receipt.test", async () => {
    const repo = tmp(), data = tmp();
    const r = await cb.runCodingTask({ task: "add a note", repoPath: repo, backend: "mock" }, { dataDir: data });
    assert.strictEqual(r.ok, true);
    const rc = cb.readReceipts({ dataDir: data }).find((x) => x.id === r.receiptId);
    assert(rc.test && typeof rc.test === "object", "receipt.test is the verdict, not null");
    assert.strictEqual(rc.test.passed, null, "default path: guard-only → undecisive (null)");
  });

  await check("ENFORCE: a failing verified proposal is BLOCKED from apply; override applies it", async () => {
    const repo = fixtureRepo("process.exit(1);"); // tests always fail
    const data = tmp();
    const r = await cb.runCodingTask(
      { task: "risky change", repoPath: repo, backend: "mock" },
      { dataDir: data, verify: { enforce: true, runTests: true, testCommand: "node check.js" } }
    );
    assert.strictEqual(r.blocked, true, "enforced decisive failure → blocked");
    assert.strictEqual(r.verification.passed, false);
    const refused = await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    assert.strictEqual(refused.ok, false, "approve refused while blocked");
    assert(/verification/.test(refused.error));
    const forced = await cb.approveCodingPatch(r.pendingId, { dataDir: data, overrideVerification: true });
    assert.strictEqual(forced.ok, true, "override applies anyway");
  });

  await check("ADVISORY (enforce off): failing verdict is recorded but apply is NOT blocked", async () => {
    const repo = fixtureRepo("process.exit(1);");
    const data = tmp();
    const r = await cb.runCodingTask(
      { task: "note", repoPath: repo, backend: "mock" },
      { dataDir: data, verify: { runTests: true, testCommand: "node check.js" } } // enforce off
    );
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.verification.passed, false, "verdict still recorded as a failure");
    const ok = await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    assert.strictEqual(ok.ok, true, "advisory mode does not block apply");
  });

  await check("verifyPending re-runs verification on a still-held patch", async () => {
    const repo = fixtureRepo("process.exit(0);"); // passes
    const data = tmp();
    const r = await cb.runCodingTask({ task: "note", repoPath: repo, backend: "mock" }, { dataDir: data });
    assert.strictEqual(r.verification.decisive, false, "first pass: guard only");
    const re = await cb.verifyPending(r.pendingId, { dataDir: data, verify: { runTests: true, testCommand: "node check.js" } });
    assert.strictEqual(re.ok, true);
    assert.strictEqual(re.verification.passed, true, "re-verify now runs the tests and passes");
    const rc = cb.readReceipts({ dataDir: data }).find((x) => x.id === r.receiptId && x.test && x.test.decisive);
    assert(rc, "receipt.test updated with the decisive verdict");
  });

  // ── regression: the default path did NOT change the #2175 router outcomes ─
  await check("REGRESSION: default run keeps router invariants (no outcome pre-resolution; approve=success; reject=failure)", async () => {
    const repo = tmp(), data = tmp();
    const repoName = path.basename(repo);
    const r = await cb.runCodingTask({ task: "fix the bug", repoPath: repo, backend: "mock" }, { dataDir: data });
    // guard-only verdict must NOT fabricate an outcome before the user resolves it
    assert(!router.outcomeStats({ dataDir: data }).some((s) => s.attempts > 0 && s.repo === repoName), "no outcome before resolution");
    await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    const s = router.outcomeStats({ dataDir: data }).find((x) => x.repo === repoName && x.backend === "mock");
    assert(s && s.successes === 1, "approved → success outcome (unchanged)");
  });

  // ── hardening: sandbox containment (review-confirmed) ────────────────────
  await check("tests-run REFUSES a proposal path that escapes the repo — no outside write", async () => {
    const parent = tmp();
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "check.js"), "process.exit(0);");
    const outside = path.join(parent, "SECRET.txt");
    fs.writeFileSync(outside, "ORIGINAL");
    const r = await testsRun.runTests(
      { repoPath: repo, files: [{ path: "../SECRET.txt", content: "PWNED" }] },
      { testCommand: "node check.js" }
    );
    assert.strictEqual(r.skipped, true, "escaping path → whole run refused");
    assert(/escapes repo/.test(r.reason));
    assert.strictEqual(fs.readFileSync(outside, "utf8"), "ORIGINAL", "outside file never touched");
  });

  await check("approveCodingPatch REFUSES an escaping proposal path", async () => {
    const parent = tmp();
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    const data = tmp();
    const outside = path.join(parent, "OUT.txt");
    fs.writeFileSync(outside, "SAFE");
    // craft a held pending with an escaping file directly via a mock run, then swap input
    const r = await cb.runCodingTask({ task: "note", repoPath: repo, backend: "mock" }, { dataDir: data });
    // append a pending update whose input carries an escaping file (simulating a hostile proposal)
    fs.appendFileSync(
      path.join(data, "coding-pending.jsonl"),
      JSON.stringify({ id: r.pendingId, input: { repoPath: repo, files: [{ path: "../OUT.txt", content: "PWNED" }], receiptId: r.receiptId } }) + "\n"
    );
    const res = await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    assert.strictEqual(res.ok, false, "apply refused");
    assert.strictEqual(fs.readFileSync(outside, "utf8"), "SAFE", "outside file untouched");
  });

  await check("tests-run cleans up directories it created (tree left as found)", async () => {
    const repo = fixtureRepo("process.exit(0);");
    const r = await testsRun.runTests(
      { repoPath: repo, files: [{ path: "brand/new/dir/file.txt", content: "x" }] },
      { testCommand: "node check.js" }
    );
    assert.strictEqual(r.passed, true);
    assert(!fs.existsSync(path.join(repo, "brand")), "created directories removed on restore");
  });

  await check("tests-run treats a maxBuffer overflow as UNDECIDABLE (skipped), not a false failure", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "big.js"), "require('fs').writeSync(1,'x'.repeat(9*1024*1024));process.exit(0);");
    const r = await testsRun.runTests({ repoPath: repo, files: [{ path: "noop.txt", content: "1" }] }, { testCommand: "node big.js" });
    assert.strictEqual(r.skipped, true, "huge output → cannot decide");
    assert(/buffer/i.test(r.reason));
  });

  // ── hardening: router precedence (review-confirmed inversion) ─────────────
  await check("PRECEDENCE: a user REJECT beats a decisive verifier PASS (rejected ≠ success)", async () => {
    const repo = fixtureRepo("process.exit(0);"); // tests pass
    const data = tmp();
    const repoName = path.basename(repo);
    const r = await cb.runCodingTask({ task: "note", repoPath: repo, backend: "mock" }, { dataDir: data });
    await cb.verifyPending(r.pendingId, { dataDir: data, verify: { runTests: true, testCommand: "node check.js" } }); // decisive PASS
    await cb.rejectCodingPatch(r.pendingId, { dataDir: data });
    const s = router.outcomeStats({ dataDir: data }).find((x) => x.repo === repoName && x.backend === "mock");
    assert(s && s.attempts === 1 && s.successes === 0, "rejected patch is a FAILURE outcome despite the passing verdict");
  });

  await check("PRECEDENCE: a decisive verifier FAILURE beats a force-apply (applied ≠ success)", async () => {
    const repo = fixtureRepo("process.exit(1);"); // tests fail
    const data = tmp();
    const repoName = path.basename(repo);
    const r = await cb.runCodingTask(
      { task: "note", repoPath: repo, backend: "mock" },
      { dataDir: data, verify: { enforce: true, runTests: true, testCommand: "node check.js" } }
    );
    assert.strictEqual(r.blocked, true);
    await cb.approveCodingPatch(r.pendingId, { dataDir: data, overrideVerification: true }); // force-applied
    const s = router.outcomeStats({ dataDir: data }).find((x) => x.repo === repoName && x.backend === "mock");
    assert(s && s.attempts === 1 && s.successes === 0, "force-applied failing patch is a FAILURE outcome");
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall coding-verifier (#2174) tests passed");
  process.exit(failures ? 1 : 0);
})();
