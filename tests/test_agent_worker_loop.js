/**
 * Tests for src/agent-worker-loop.js — class-based QueueManager API
 * Run: node tests/test_agent_worker_loop.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const SRC  = path.resolve(__dirname, "../src");
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-wl-test-"));
const QDIR = path.join(TMP, "queue");
const WT   = path.join(TMP, "wt-100");
fs.mkdirSync(WT, { recursive: true });

const QueueManager = require(`${SRC}/queue-manager`);
const q = new QueueManager(QDIR);

// ── Inject mocks before loading dependent modules ─────────────────────────────

// worktree-manager stub
require.cache[require.resolve(`${SRC}/worktree-manager`)] = {
  id: `${SRC}/worktree-manager`, loaded: true,
  exports: {
    createWorktree(lane, num) {
      return { worktreePath: path.join(TMP, "wt-" + num), branch: "claude/issue-" + num };
    },
    removeWorktree() {},
    listWorktrees() { return []; },
    WORKTREE_BASE: TMP,
  }
};

// QueueManager mock using isolated dir
require.cache[require.resolve(`${SRC}/queue-manager`)] = {
  id: `${SRC}/queue-manager`, loaded: true,
  exports: class IsolatedQM extends QueueManager { constructor() { super(QDIR); } }
};

// Reload queue-dep modules fresh
delete require.cache[require.resolve(`${SRC}/work-dispatcher`)];
delete require.cache[require.resolve(`${SRC}/agent-worker-loop`)];

// Stub spawnSync + git/push/PR helpers in agent-worker-loop by patching src
let wlSrc = fs.readFileSync(`${SRC}/agent-worker-loop.js`, "utf8");

// Stub spawnClaudeAgent — always returns ok
wlSrc = wlSrc.replace(
  /function spawnClaudeAgent\([\s\S]*?^}/m,
  `function spawnClaudeAgent() { return { ok: true, stdout: "mock", stderr: "", status: 0 }; }`
);
// Stub commitAgentWork
wlSrc = wlSrc.replace(
  /function commitAgentWork\([\s\S]*?^}/m,
  `function commitAgentWork() { return { committed: true }; }`
);
// Stub runTests
wlSrc = wlSrc.replace(
  /function runTests\([\s\S]*?^}/m,
  `function runTests() { return { passed: true, output: "ok" }; }`
);
// Stub pushBranch
wlSrc = wlSrc.replace(
  /function pushBranch\([\s\S]*?^}/m,
  `function pushBranch() { return { ok: true }; }`
);
// Stub createPR
wlSrc = wlSrc.replace(
  /function createPR\([\s\S]*?^}/m,
  `function createPR() { return { ok: true, url: "https://github.com/alex-place/lantern-os/pull/999" }; }`
);
// Use isolated queue path
wlSrc = wlSrc.replace(
  'new QueueManager(path.join(REPO_ROOT, "data", "agent-work-queue"))',
  `new QueueManager(${JSON.stringify(QDIR)})`
);

// Rewrite all ./relative requires to absolute src/ paths so TMP copy resolves them
wlSrc = wlSrc.replace(/require\("(\.\/[^"]+)"\)/g, (_, rel) =>
  `require(${JSON.stringify(path.resolve(SRC, rel))})`
);

const wlTmp = path.join(TMP, "agent-worker-loop.js");
fs.writeFileSync(wlTmp, wlSrc);
const wl = require(wlTmp);

// ── Harness ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

(async () => {
  section("processOne — empty queue");
  const nothing = await wl.processOne("claude/", { keepWorktree: true });
  assert("null on empty queue", nothing === null);

  section("processOne — happy path");
  await q.enqueueWork({ issueNumber: 100, title: "Test issue", lane: "claude/" });
  const receipt = await wl.processOne("claude/", { keepWorktree: true });
  assert("returns receipt", receipt !== null);
  assert("receipt ok", receipt?.ok === true);
  assert("has steps", Array.isArray(receipt?.steps) && receipt.steps.length > 0);
  assert("agent step present", receipt?.steps?.some(s => s.name === "agent"));
  assert("pr_url set", receipt?.pr_url?.includes("pull/999"));

  section("processOne — empty after first");
  assert("null when drained", await wl.processOne("claude/", { keepWorktree: true }) === null);

  section("runLoop");
  await q.enqueueWork({ issueNumber: 201, title: "Task A", lane: "claude/" });
  await q.enqueueWork({ issueNumber: 202, title: "Task B", lane: "claude/" });
  const receipts = await wl.runLoop("claude/", { keepWorktree: true });
  // runLoop returns what slots are available; 0 is valid if slots were exhausted
  assert("runLoop returns array", Array.isArray(receipts));
  assert("all receipts ok", receipts.every(r => r.ok));
  const status = await q.getStatus();
  assert("queue has no stuck assigned items", status.assigned === 0);

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
