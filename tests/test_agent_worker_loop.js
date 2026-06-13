/**
 * Tests for src/agent-worker-loop.js
 * Run: node tests/test_agent_worker_loop.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-worker-test-"));

// ── Stub all dependencies ─────────────────────────────────────────────────────

// queue-manager stub
const qmTmp = path.join(TMP, "queue-manager.js");
const qmState = { entries: {}, completed: [], failed: [] };
fs.writeFileSync(qmTmp, `
"use strict";
const state = ${JSON.stringify(qmState)};
// keep a shared reference the test can inspect
global.__qmState = state;
module.exports = {
  complete(id, receipt) { state.completed.push({ id, receipt }); },
  fail(id, reason)      { state.failed.push({ id, reason }); },
  updateEntry(id, patch){ state.entries[id] = Object.assign(state.entries[id]||{}, patch); },
};
`);

// agent-slot-manager stub
const smTmp = path.join(TMP, "agent-slot-manager.js");
const smState = { heartbeats: 0, idles: 0, failures: [] };
fs.writeFileSync(smTmp, `
"use strict";
global.__smState = { heartbeats: 0, idles: 0, failures: [] };
module.exports = {
  markIdle(id)           { global.__smState.idles++; },
  markFailed(id, reason) { global.__smState.failures.push({ id, reason }); return { retry: false, exhausted: true }; },
  heartbeat(id)          { global.__smState.heartbeats++; },
};
`);

// worktree-manager stub
const wmTmp = path.join(TMP, "worktree-manager.js");
fs.writeFileSync(wmTmp, `
"use strict";
module.exports = {
  removeWorktree(p) {},
  WORKTREE_BASE: ${JSON.stringify(TMP)},
};
`);

// work-dispatcher stub — returns a fake work item on first call, null after
const wtPath = path.join(TMP, "wt-mock");
fs.mkdirSync(wtPath, { recursive: true });
const wdTmp = path.join(TMP, "work-dispatcher.js");
fs.writeFileSync(wdTmp, `
"use strict";
let calls = 0;
module.exports = {
  dispatchOne: async (lane, opts) => {
    if (calls++ > 0) return null;
    return {
      entry:       { id: "wq-100-test", issue_number: 100, title: "Test issue", lane: "claude/" },
      slot:        { id: "claude-1", lane: "claude/", status: "working" },
      worktreePath: ${JSON.stringify(wtPath)},
      branch:      "claude/issue-100-test-issue",
      context:     { title: "Test issue", issue_url: "https://github.com/alex-place/lantern-os/issues/100", body_excerpt: "Fix the thing.", instructions: "#100 Test issue" },
    };
  },
};
`);

// Patch agent-worker-loop
let wlSrc = fs.readFileSync(path.resolve(__dirname, "../src/agent-worker-loop.js"), "utf8")
  .replace(`require("./queue-manager")`,     `require(${JSON.stringify(qmTmp)})`)
  .replace(`require("./agent-slot-manager")`, `require(${JSON.stringify(smTmp)})`)
  .replace(`require("./work-dispatcher")`,    `require(${JSON.stringify(wdTmp)})`)
  .replace(`require("./worktree-manager")`,   `require(${JSON.stringify(wmTmp)})`);

// Stub spawnClaudeAgent to avoid real CLI
wlSrc = wlSrc.replace(
  "function spawnClaudeAgent(worktreePath, context) {",
  `function spawnClaudeAgent(worktreePath, context) {
    return { ok: true, stdout: "mock agent output", stderr: "", status: 0 };
    /* original below — unreachable in test */`
).replace(
  // close the stub before the original function end — find a reliable anchor
  `  return {\n    ok:     result.status === 0,`,
  `  // (stubbed out)\n  return {\n    ok:     result.status === 0,`
);

// Stub commitAgentWork, runTests, createPR for deterministic results
wlSrc = wlSrc
  .replace("function commitAgentWork(", "function commitAgentWork_ORIG(")
  .replace("function runTests(",        "function runTests_ORIG(")
  .replace("function createPR(",        "function createPR_ORIG(")
  .replace("function pushBranch(",      "function pushBranch_ORIG(");
wlSrc += `
function commitAgentWork(p, n, t) { return { committed: true }; }
function runTests(p)              { return { passed: true, output: "ok" }; }
function pushBranch(p, b)         { return { ok: true }; }
function createPR(branch, n, t)   { return { ok: true, url: "https://github.com/alex-place/lantern-os/pull/999" }; }
`;

const wlTmp = path.join(TMP, "agent-worker-loop.js");
fs.writeFileSync(wlTmp, wlSrc);
const wl = require(wlTmp);

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

(async () => {
  section("processOne — happy path");
  const receipt = await wl.processOne("claude/", { keepWorktree: true });
  assert("returns receipt", receipt !== null);
  assert("receipt ok", receipt.ok === true);
  assert("correct issue", receipt.issue_number === 100);
  assert("has branch", receipt.branch === "claude/issue-100-test-issue");
  assert("has steps", Array.isArray(receipt.steps) && receipt.steps.length > 0);
  assert("agent step present", receipt.steps.some(s => s.name === "agent"));
  assert("pr_url set", receipt.pr_url?.includes("pull/999"));
  assert("slot marked idle", global.__smState.idles >= 1);
  assert("queue entry completed", global.__qmState.completed.length === 1);
  assert("heartbeat called", global.__smState.heartbeats > 0);

  section("processOne — empty queue");
  const noWork = await wl.processOne("claude/", { keepWorktree: true });
  assert("returns null on empty queue", noWork === null);

  section("runLoop");
  // reset dispatcher call count by re-requiring a fresh stub
  const wdTmp2 = path.join(TMP, "work-dispatcher2.js");
  fs.writeFileSync(wdTmp2, `
"use strict";
let calls = 0;
module.exports = { dispatchOne: async () => calls++ < 2 ? {
  entry: { id: "wq-2"+calls, issue_number: 200+calls, title: "Task "+calls, lane: "claude/" },
  slot:  { id: "claude-1", lane: "claude/", status: "working" },
  worktreePath: null, branch: null,
  context: { title: "Task", issue_url: "https://github.com/alex-place/lantern-os/issues/200", body_excerpt: "" },
} : null };
`);
  let wlSrc2 = fs.readFileSync(wlTmp, "utf8")
    .replace(`require(${JSON.stringify(wdTmp)})`, `require(${JSON.stringify(wdTmp2)})`);
  const wlTmp2 = path.join(TMP, "worker-loop2.js");
  fs.writeFileSync(wlTmp2, wlSrc2);
  const wl2 = require(wlTmp2);
  const receipts = await wl2.runLoop("claude/", { keepWorktree: true });
  assert("runLoop processes 2 items", receipts.length === 2);
  assert("all receipts ok", receipts.every(r => r.ok));

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
