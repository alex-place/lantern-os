// coding-router.test.js — #2175: outcome-based per-repo routing. Routes by what actually
// SUCCEEDED on THIS repo (learned from the coding-backend's receipts), cold-starts on a
// default, and falls back to the answer-first cascade when there's no signal.
// Run: node test/coding-router.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cb = require("../lib/coding-backend");
const router = require("../lib/coding-backend/router");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL-", name, "\n      ", e.message);
  }
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kb-rt-"));
}
function seed(dataDir, repo, backend, taskType, nSucc, nFail) {
  for (let i = 0; i < nSucc; i++) router.recordOutcome({ repo, backend, taskType, success: true }, { dataDir });
  for (let i = 0; i < nFail; i++) router.recordOutcome({ repo, backend, taskType, success: false }, { dataDir });
}

(async () => {
  await check("taskTypeOf classifies by keyword (test/bugfix/feature/other)", () => {
    assert.strictEqual(router.taskTypeOf("add a unit test for parser"), "test");
    assert.strictEqual(router.taskTypeOf("fix the crash on null input"), "bugfix");
    assert.strictEqual(router.taskTypeOf("implement a new export button"), "feature");
    assert.strictEqual(router.taskTypeOf("ponder the universe"), "other");
  });

  await check("route picks the backend with the best MEASURED success on this repo+type", () => {
    const data = tmp();
    seed(data, "acme", "aider", "bugfix", 4, 1); // 80%
    seed(data, "acme", "ollama", "bugfix", 1, 4); // 20%
    const d = router.route({ repo: "acme", taskType: "bugfix", candidates: ["aider", "ollama"], defaultBackend: "ollama", minAttempts: 3 }, { dataDir: data });
    assert.strictEqual(d.backend, "aider", "should pick the higher-success backend");
    assert.strictEqual(d.hasSignal, true);
    assert(/measured/.test(d.reason));
  });

  await check("cold-start: no history → defaultBackend + hasSignal:false (→ cascade)", () => {
    const data = tmp();
    const d = router.route({ repo: "brand-new-repo", taskType: "feature", candidates: ["aider", "ollama"], defaultBackend: "ollama", minAttempts: 3 }, { dataDir: data });
    assert.strictEqual(d.backend, "ollama");
    assert.strictEqual(d.hasSignal, false);
    assert(/cold-start/.test(d.reason));
  });

  await check("below minAttempts → cold-start (not enough signal to trust)", () => {
    const data = tmp();
    seed(data, "acme", "aider", "feature", 2, 0); // only 2 outcomes, minAttempts=3
    const d = router.route({ repo: "acme", taskType: "feature", candidates: ["aider"], defaultBackend: "ollama", minAttempts: 3 }, { dataDir: data });
    assert.strictEqual(d.hasSignal, false);
    assert.strictEqual(d.backend, "ollama");
  });

  await check("outcomes are keyed per-repo (same backend, different repos, different winner)", () => {
    const data = tmp();
    seed(data, "repoA", "aider", "bugfix", 5, 0); // aider wins repoA
    seed(data, "repoA", "ollama", "bugfix", 0, 5);
    seed(data, "repoB", "ollama", "bugfix", 5, 0); // ollama wins repoB
    seed(data, "repoB", "aider", "bugfix", 0, 5);
    assert.strictEqual(router.route({ repo: "repoA", taskType: "bugfix", candidates: ["aider", "ollama"], minAttempts: 3 }, { dataDir: data }).backend, "aider");
    assert.strictEqual(router.route({ repo: "repoB", taskType: "bugfix", candidates: ["aider", "ollama"], minAttempts: 3 }, { dataDir: data }).backend, "ollama");
  });

  await check("outcomes are FED FROM RECEIPTS: mock run → approve → counts as a success", async () => {
    const repoDir = tmp(), data = tmp();
    const repoName = path.basename(repoDir);
    const r = await cb.runCodingTask({ task: "fix the parser bug", repoPath: repoDir, backend: "mock" }, { dataDir: data });
    // receipt carries repo + taskType
    const rc = cb.readReceipts({ dataDir: data }).find((x) => x.id === r.receiptId);
    assert.strictEqual(rc.repo, repoName);
    assert.strictEqual(rc.taskType, "bugfix");
    // still "proposed" → no outcome yet
    assert(!router.outcomeStats({ dataDir: data }).some((s) => s.attempts > 0 && s.repo === repoName), "no outcome before resolution");
    // approve → applied → success outcome
    await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    const s = router.outcomeStats({ dataDir: data }).find((x) => x.repo === repoName && x.backend === "mock" && x.taskType === "bugfix");
    assert(s && s.attempts === 1 && s.successes === 1, "approved receipt is a success outcome");
  });

  await check("rejected receipt counts as a FAILURE outcome", async () => {
    const repoDir = tmp(), data = tmp();
    const repoName = path.basename(repoDir);
    const r = await cb.runCodingTask({ task: "add a feature", repoPath: repoDir, backend: "mock" }, { dataDir: data });
    await cb.rejectCodingPatch(r.pendingId, { dataDir: data });
    const s = router.outcomeStats({ dataDir: data }).find((x) => x.repo === repoName && x.backend === "mock");
    assert(s && s.attempts === 1 && s.successes === 0, "rejected receipt is a failure outcome");
  });

  await check("routeCodingTask routes to the measured winner and runs it", async () => {
    const repoDir = tmp(), data = tmp();
    const repoName = path.basename(repoDir);
    // seed mock as the proven winner for this repo+type so the router picks it
    seed(data, repoName, "mock", "bugfix", 4, 0);
    const r = await cb.routeCodingTask({ task: "fix the crash", repoPath: repoDir, candidates: ["mock", "ollama"], defaultBackend: "ollama" }, { dataDir: data });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.routing.hasSignal, true);
    assert.strictEqual(r.routing.backend, "mock");
    assert.strictEqual(r.backend, "mock");
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall coding-router (#2175) tests passed");
  process.exit(failures ? 1 : 0);
})();
