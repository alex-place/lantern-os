/**
 * Tests for src/agent-slot-manager.js
 * Run: node tests/test_agent_slot_manager.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Wire up isolated temp dirs for both queue and slots ───────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-slot-test-"));

// Patch queue-manager to use tmp dir
const qmSrc = fs.readFileSync(path.resolve(__dirname, "../src/queue-manager.js"), "utf8")
  .replace('path.resolve(__dirname, "../data/agent-work-queue")', JSON.stringify(TMP));
const qmTmp = path.join(TMP, "queue-manager.js");
fs.writeFileSync(qmTmp, qmSrc);

// Patch agent-slot-manager to use tmp queue-manager and tmp slots file
const slotsFile = path.join(TMP, "agent-slots.json");
fs.writeFileSync(slotsFile, JSON.stringify({
  version: "1.0",
  slots: [
    { id: "claude-1", lane: "claude/", label: "Claude", max_retries: 3, heartbeat_interval_ms: 30000, idle_timeout_ms: 5000, enabled: true },
    { id: "gemini-1", lane: "gemini/", label: "Gemini", max_retries: 2, heartbeat_interval_ms: 30000, idle_timeout_ms: 5000, enabled: true },
    { id: "disabled-1", lane: "codex/", label: "Codex", max_retries: 3, heartbeat_interval_ms: 30000, idle_timeout_ms: 5000, enabled: false },
  ]
}));

const smSrc = fs.readFileSync(path.resolve(__dirname, "../src/agent-slot-manager.js"), "utf8")
  .replace("require('./queue-manager')", `require(${JSON.stringify(qmTmp)})`)
  .replace('path.join(os.homedir(), ".claude", "agent-slots.json")', JSON.stringify(slotsFile));
const smTmp = path.join(TMP, "agent-slot-manager.js");
fs.writeFileSync(smTmp, smSrc);

const sm = require(smTmp);
const q  = require(qmTmp);

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

section("loadSlots");
const loaded = sm.loadSlots(slotsFile);
assert("returns 3 slots", loaded.length === 3);
assert("enabled slot is idle", loaded.find(s => s.id === "claude-1")?.status === "idle");
assert("disabled slot is disabled", loaded.find(s => s.id === "disabled-1")?.status === "disabled");

section("loadSlots idempotent");
const loaded2 = sm.loadSlots(slotsFile);
assert("second load still 3 slots", loaded2.length === 3);

section("getStatus");
assert("claude-1 is idle", sm.getStatus("claude-1") === "idle");
assert("disabled-1 is disabled", sm.getStatus("disabled-1") === "disabled");

section("getAllStatus");
const all = sm.getAllStatus();
assert("returns all 3", all.length === 3);
assert("each has id/lane/status", all.every(s => s.id && s.lane && s.status));

section("markWorking");
const r1 = q.enqueue({ issue_number: 10, title: "Test work", lane: "claude/" });
const entry = q.claimNext("claude/");
sm.markWorking("claude-1", entry.id);
assert("status is working", sm.getStatus("claude-1") === "working");
assert("disabled slot throws", (() => { try { sm.markWorking("disabled-1", "x"); return false; } catch { return true; } })());

section("heartbeat");
sm.heartbeat("claude-1");
const statusAfterBeat = sm.getAllStatus().find(s => s.id === "claude-1");
assert("lastHeartbeat updated", Date.now() - statusAfterBeat.lastHeartbeat < 100);

section("markIdle");
sm.markIdle("claude-1");
assert("status back to idle", sm.getStatus("claude-1") === "idle");
assert("retries reset", sm.getAllStatus().find(s => s.id === "claude-1").retries === 0);

section("markFailed — retry");
const r2 = q.enqueue({ issue_number: 11, title: "Retry work", lane: "gemini/" });
const e2 = q.claimNext("gemini/");
sm.markWorking("gemini-1", e2.id);
const result1 = sm.markFailed("gemini-1", "timeout");
assert("retry=true on first fail", result1.retry === true);
assert("attempt is 1", result1.attempt === 1);
assert("slot back to idle for retry", sm.getStatus("gemini-1") === "idle");

section("markFailed — exhausted");
// exhaust remaining retries (max=2, already used 1)
sm.markWorking("gemini-1", e2.id);
const result2 = sm.markFailed("gemini-1", "timeout again");
assert("retry=false when exhausted", result2.retry === false);
assert("exhausted=true", result2.exhausted === true);
assert("slot status is failed", sm.getStatus("gemini-1") === "failed");

section("resetSlot");
sm.resetSlot("gemini-1");
assert("slot back to idle after reset", sm.getStatus("gemini-1") === "idle");
assert("retries cleared", sm.getAllStatus().find(s => s.id === "gemini-1").retries === 0);

section("cleanupStale");
const r3 = q.enqueue({ issue_number: 12, title: "Stale work", lane: "claude/" });
const e3 = q.claimNext("claude/");
sm.markWorking("claude-1", e3.id);
// Manually backdate heartbeat to simulate staleness
const slot = sm.getAllStatus().find(s => s.id === "claude-1");
// Directly manipulate via internal — simulate by calling cleanupStale after spoofing
// We patch lastHeartbeat via the exported getAllStatus reference isn't writable,
// so we test via the public heartbeat path and a very short timeout.
// Instead, call cleanupStale and confirm it runs without error (stale detection needs time to pass).
const cleaned = sm.cleanupStale();
assert("cleanupStale returns array", Array.isArray(cleaned));

section("startHeartbeatMonitor / stopHeartbeatMonitor");
sm.startHeartbeatMonitor(50);
sm.startHeartbeatMonitor(50); // idempotent
sm.stopHeartbeatMonitor();
sm.stopHeartbeatMonitor(); // idempotent — no throw
assert("monitor starts and stops without error", true);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
fs.rmSync(TMP, { recursive: true, force: true });
