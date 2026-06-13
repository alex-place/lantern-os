/**
 * Tests for src/work-dispatcher.js — class-based QueueManager API
 * Run: node tests/test_work_dispatcher.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const SRC    = path.resolve(__dirname, "../src");
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-disp-test-"));
const QDIR   = path.join(TMP, "queue");

// Use real QueueManager with isolated temp dir
const QueueManager    = require(`${SRC}/queue-manager`);
const AgentSlotManager = require(`${SRC}/agent-slot-manager`);

const q  = new QueueManager(QDIR);

// Inject mocks into require cache BEFORE loading work-dispatcher
// so it picks up our isolated queue + stubbed worktree-manager
require.cache[require.resolve(`${SRC}/queue-manager`)]     = { id: `${SRC}/queue-manager`,     exports: class MockQM extends QueueManager { constructor() { super(QDIR); } }, loaded: true };
require.cache[require.resolve(`${SRC}/worktree-manager`)]  = {
  id: `${SRC}/worktree-manager`, loaded: true,
  exports: {
    createWorktree(lane, num) {
      const p = path.join(TMP, "wt-" + num);
      fs.mkdirSync(p, { recursive: true });
      return { worktreePath: p, branch: "claude/issue-" + num };
    },
    removeWorktree() {},
    listWorktrees() { return []; },
    WORKTREE_BASE: TMP,
  }
};

// Load work-dispatcher after mocks injected
delete require.cache[require.resolve(`${SRC}/work-dispatcher`)];
const wd = require(`${SRC}/work-dispatcher`);

// ── Harness ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

(async () => {
  section("dispatchOne — empty queue");
  assert("null on empty queue", await wd.dispatchOne("claude/") === null);

  section("dispatchOne — basic dispatch");
  await q.enqueueWork({ issueNumber: 100, title: "Add feature X", lane: "claude/" });
  const work = await wd.dispatchOne("claude/");
  assert("returns work item", work !== null);
  assert("entry has issue 100", (work?.entry?.issueNumber || work?.entry?.issue_number) === 100);
  assert("slot is set", !!work?.slot?.id);
  assert("branch set", typeof work?.branch === "string" && work.branch.includes("100"));
  assert("worktreePath set", typeof work?.worktreePath === "string");
  assert("context instructions", work?.context?.instructions?.includes("100"));

  section("dispatchOne — queue empty after dispatch");
  assert("null when drained", await wd.dispatchOne("claude/") === null);

  section("buildWorkContext");
  const ctx = wd.buildWorkContext({
    issueNumber: 999,
    issueUrl: "https://github.com/alex-place/lantern-os/issues/999",
    title: "Fix the bug",
    body: "Steps to reproduce.",
    lane: "claude/"
  });
  assert("issue_number", ctx.issue_number === 999);
  assert("title", ctx.title === "Fix the bug");
  assert("instructions has #999", ctx.instructions.includes("#999"));
  assert("body_excerpt from body", ctx.body_excerpt.includes("Steps"));

  section("dispatchAll");
  await q.enqueueWork({ issueNumber: 201, title: "Task 1", lane: "claude/" });
  await q.enqueueWork({ issueNumber: 202, title: "Task 2", lane: "claude/" });
  const all = await wd.dispatchAll(null, { createTree: false });
  assert("dispatched at least 1 item", all.length >= 1);

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
