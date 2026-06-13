/**
 * Tests for src/work-dispatcher.js
 * Run: node tests/test_work_dispatcher.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-dispatch-test-"));

// Patch queue-manager
const qmSrc = fs.readFileSync(path.resolve(__dirname, "../src/queue-manager.js"), "utf8")
  .replace('path.resolve(__dirname, "../data/agent-work-queue")', JSON.stringify(TMP));
const qmTmp = path.join(TMP, "queue-manager.js");
fs.writeFileSync(qmTmp, qmSrc);

// Patch agent-slot-manager
const slotsFile = path.join(TMP, "agent-slots.json");
fs.writeFileSync(slotsFile, JSON.stringify({ version: "1.0", slots: [
  { id: "claude-1", lane: "claude/", label: "Claude", max_retries: 3, heartbeat_interval_ms: 30000, idle_timeout_ms: 60000, enabled: true },
  { id: "gemini-1", lane: "gemini/", label: "Gemini", max_retries: 2, heartbeat_interval_ms: 30000, idle_timeout_ms: 60000, enabled: true },
]}));
const smSrc = fs.readFileSync(path.resolve(__dirname, "../src/agent-slot-manager.js"), "utf8")
  .replace("require('./queue-manager')", `require(${JSON.stringify(qmTmp)})`)
  .replace('path.join(os.homedir(), ".claude", "agent-slots.json")', JSON.stringify(slotsFile));
const smTmp = path.join(TMP, "agent-slot-manager.js");
fs.writeFileSync(smTmp, smSrc);

// Patch worktree-manager to be a stub (no real git ops in tests)
const wmTmp = path.join(TMP, "worktree-manager.js");
fs.writeFileSync(wmTmp, `
"use strict";
const path = require("path");
const WORKTREE_BASE = ${JSON.stringify(TMP)};
function createWorktree(lane, issueNumber, title) {
  const branch = lane.replace(/\\/$/,"") + "/issue-" + issueNumber;
  const worktreePath = path.join(WORKTREE_BASE, "wt-" + issueNumber);
  require("fs").mkdirSync(worktreePath, { recursive: true });
  return { worktreePath, branch };
}
function removeWorktree(p) { try { require("fs").rmSync(p, { recursive: true }); } catch {} }
function listWorktrees() { return []; }
module.exports = { createWorktree, removeWorktree, listWorktrees, WORKTREE_BASE };
`);

// Patch work-dispatcher
const wdSrc = fs.readFileSync(path.resolve(__dirname, "../src/work-dispatcher.js"), "utf8")
  .replace("require('./queue-manager')", `require(${JSON.stringify(qmTmp)})`)
  .replace("require('./agent-slot-manager')", `require(${JSON.stringify(smTmp)})`)
  .replace("require('./worktree-manager')", `require(${JSON.stringify(wmTmp)})`);
const wdTmp = path.join(TMP, "work-dispatcher.js");
fs.writeFileSync(wdTmp, wdSrc);

const q  = require(qmTmp);
const sm = require(smTmp);
const wd = require(wdTmp);

sm.loadSlots(slotsFile);

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

section("dispatchOne — empty queue");
(async () => {
  const item = await wd.dispatchOne("claude/");
  assert("returns null on empty queue", item === null);

  section("dispatchOne — basic dispatch");
  q.enqueue({ issue_number: 100, title: "Add feature X", lane: "claude/" });
  const work = await wd.dispatchOne("claude/");
  assert("returns work item", work !== null);
  assert("entry has correct issue", work.entry.issue_number === 100);
  assert("slot is assigned", work.slot.id === "claude-1");
  assert("branch is set", typeof work.branch === "string" && work.branch.includes("100"));
  assert("worktreePath is set", typeof work.worktreePath === "string");
  assert("context has instructions", work.context.instructions.includes("#100"));
  assert("slot is now working", sm.getStatus("claude-1") === "working");

  section("dispatchOne — no idle slots");
  q.enqueue({ issue_number: 101, title: "Another issue", lane: "claude/" });
  const noSlot = await wd.dispatchOne("claude/"); // claude-1 is working
  assert("returns null when no idle claude slot", noSlot === null);

  section("dispatchOne — different lane");
  q.enqueue({ issue_number: 102, title: "Gemini issue", lane: "gemini/" });
  const geminiWork = await wd.dispatchOne("gemini/");
  assert("gemini can claim its own lane", geminiWork?.entry.issue_number === 102);
  assert("gemini slot is working", sm.getStatus("gemini-1") === "working");

  section("buildWorkContext");
  const ctx = wd.buildWorkContext({
    issue_number: 999, issue_url: "https://github.com/alex-place/lantern-os/issues/999",
    title: "Test issue", body_excerpt: "Fix the thing.", labels: ["bug"], lane: "claude/"
  });
  assert("instructions contains issue number", ctx.instructions.includes("#999"));
  assert("instructions contains title", ctx.instructions.includes("Test issue"));
  assert("instructions contains url", ctx.instructions.includes("issues/999"));

  section("dispatchAll");
  sm.markIdle("claude-1");
  sm.markIdle("gemini-1");
  // pending still has issue 101
  const dispatched = await wd.dispatchAll(null, { createTree: true });
  assert("dispatched at least 1 item", dispatched.length >= 1);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
