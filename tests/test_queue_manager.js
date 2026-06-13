/**
 * Tests for src/queue-manager.js
 * Run: node tests/test_queue_manager.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Redirect queue dir to a temp directory so tests don't pollute real data ──
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-queue-test-"));
process.env.LANTERN_QUEUE_DIR = TMP_DIR; // queue-manager reads this if set

// Patch the module path before requiring
const qmPath = path.resolve(__dirname, "../src/queue-manager.js");
// We need to override QUEUE_DIR — reload with patched path
delete require.cache[qmPath];
const src = fs.readFileSync(qmPath, "utf8").replace(
  'path.resolve(__dirname, "../data/agent-work-queue")',
  JSON.stringify(TMP_DIR)
);
const tmpModule = path.join(TMP_DIR, "queue-manager-test.js");
fs.writeFileSync(tmpModule, src);
const q = require(tmpModule);

// ── Tiny test harness ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(name) { console.log(`\n── ${name}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

section("enqueue");
const r1 = q.enqueue({ issue_number: 1, title: "Fix login bug", lane: "claude/" });
assert("returns ok", r1.ok === true);
assert("entry has correct issue_number", r1.entry.issue_number === 1);
assert("entry status is pending", r1.entry.status === "pending");
assert("entry has id", typeof r1.entry.id === "string" && r1.entry.id.startsWith("wq-1-"));
assert("entry has queued_at", !!r1.entry.queued_at);

section("enqueue idempotent");
const r2 = q.enqueue({ issue_number: 1, title: "Fix login bug", lane: "claude/" });
assert("skips duplicate", r2.skipped === true);
assert("reason is already_queued", r2.reason === "already_queued");

section("listPending");
q.enqueue({ issue_number: 2, title: "Add dark mode", lane: "gemini/" });
const pending = q.listPending();
assert("two items pending", pending.length === 2);
assert("all status pending", pending.every(e => e.status === "pending"));

section("claimNext");
const claimed = q.claimNext("claude/");
assert("returns entry", !!claimed);
assert("status is assigned", claimed.status === "assigned");
assert("lane is claude/", claimed.lane === "claude/");
assert("has assigned_at", !!claimed.assigned_at);
assert("issue 1 was claimed (lane match)", claimed.issue_number === 1);

section("claimNext — no matching lane");
const noMatch = q.claimNext("codex/");
assert("returns null when no match", noMatch === null);

section("listPending after claim");
const pendingAfter = q.listPending();
assert("one item still pending", pendingAfter.length === 1);
assert("remaining is issue 2", pendingAfter[0].issue_number === 2);

section("listAssigned");
const assigned = q.listAssigned();
assert("one item assigned", assigned.length === 1);
assert("assigned entry matches claimed id", assigned[0].id === claimed.id);

section("updateEntry");
const updated = q.updateEntry(claimed.id, { branch: "claude/fix-login", pr_number: 42 });
assert("branch updated", updated.branch === "claude/fix-login");
assert("pr_number updated", updated.pr_number === 42);
assert("status unchanged", updated.status === "assigned");

section("complete");
const receipt = { evidence: "tests passed", promoted: true };
const done = q.complete(claimed.id, receipt);
assert("status is completed", done.status === "completed");
assert("has completed_at", !!done.completed_at);
assert("receipt attached", done.receipt?.promoted === true);

section("assigned queue cleared after complete");
const assignedAfter = q.listAssigned();
assert("assigned is now empty", assignedAfter.length === 0);

section("snapshot");
const snap = q.snapshot();
assert("pending count correct", snap.pending.length === 1);
assert("assigned count correct", snap.assigned.length === 0);
assert("completed count correct", snap.completed.length === 1);

section("fail");
const claimed2 = q.claimNext("gemini/");
assert("claimed issue 2", claimed2?.issue_number === 2);
const failedEntry = q.fail(claimed2.id, "provider unavailable");
assert("status is completed (failed)", failedEntry.status === "completed");
assert("receipt has error", failedEntry.receipt?.error === "provider unavailable");

section("human/ lane fallback");
q.enqueue({ issue_number: 3, title: "Docs update", lane: "human/" });
const humanClaimed = q.claimNext("claude/");
assert("claude can claim human/ items", humanClaimed?.issue_number === 3);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Cleanup
fs.rmSync(TMP_DIR, { recursive: true, force: true });
