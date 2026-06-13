/**
 * Agent Work Queue Manager
 *
 * JSONL-based queue that distributes GitHub issues to agent lanes.
 * Three files: pending.jsonl → assigned.jsonl → completed.jsonl
 *
 * All writes are atomic (tmp-swap) to prevent race conditions.
 * Locking uses a .lock file with PID + timestamp; stale locks (>30s) are auto-cleared.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const QUEUE_DIR  = path.resolve(__dirname, "../data/agent-work-queue");
const PENDING    = path.join(QUEUE_DIR, "pending.jsonl");
const ASSIGNED   = path.join(QUEUE_DIR, "assigned.jsonl");
const COMPLETED  = path.join(QUEUE_DIR, "completed.jsonl");
const LOCK_FILE  = path.join(QUEUE_DIR, ".lock");
const LOCK_TTL   = 30_000; // ms before a stale lock is cleared

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeJsonl(file, entries) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, file);
}

function appendJsonl(file, entry) {
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

// ── Lock ─────────────────────────────────────────────────────────────────────

function acquireLock() {
  ensureDir();
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const { pid, at } = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (Date.now() - at < LOCK_TTL) {
        throw new Error(`Queue locked by PID ${pid} (acquired ${Date.now() - at}ms ago)`);
      }
    } catch (e) {
      if (e.message.startsWith("Queue locked")) throw e;
      // corrupt lock — clear it
    }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function withLock(fn) {
  acquireLock();
  try { return fn(); }
  finally { releaseLock(); }
}

// ── Entry factory ─────────────────────────────────────────────────────────────

function makeEntry({ issue_number, issue_url, title, body_excerpt = "", labels = [], lane = "human/" }) {
  return {
    id:           `wq-${issue_number}-${Date.now()}`,
    issue_number,
    issue_url:    issue_url || `https://github.com/alex-place/lantern-os/issues/${issue_number}`,
    title,
    body_excerpt: String(body_excerpt).slice(0, 500),
    labels,
    status:       "pending",
    lane,
    agent_id:     null,
    branch:       null,
    pr_number:    null,
    queued_at:    new Date().toISOString(),
    assigned_at:  null,
    completed_at: null,
    receipt:      null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a new work item (idempotent — skips if issue already pending/assigned).
 */
function enqueue(opts) {
  return withLock(() => {
    ensureDir();
    const existing = [...readJsonl(PENDING), ...readJsonl(ASSIGNED)];
    if (existing.some(e => e.issue_number === opts.issue_number)) {
      return { skipped: true, reason: "already_queued", issue_number: opts.issue_number };
    }
    const entry = makeEntry(opts);
    appendJsonl(PENDING, entry);
    return { ok: true, entry };
  });
}

/**
 * Claim the next pending item for a given lane.
 * Returns null if nothing available.
 */
function claimNext(lane) {
  return withLock(() => {
    ensureDir();
    const pending = readJsonl(PENDING);
    const idx = pending.findIndex(e => e.status === "pending" && (!lane || e.lane === lane || e.lane === "human/"));
    if (idx === -1) return null;

    const entry = { ...pending[idx], status: "assigned", lane: lane || pending[idx].lane, assigned_at: new Date().toISOString() };
    pending.splice(idx, 1);
    writeJsonl(PENDING, pending);
    appendJsonl(ASSIGNED, entry);
    return entry;
  });
}

/**
 * Update an assigned entry (e.g. set branch, pr_number, status).
 */
function updateEntry(id, patch) {
  return withLock(() => {
    ensureDir();
    const assigned = readJsonl(ASSIGNED);
    const idx = assigned.findIndex(e => e.id === id);
    if (idx === -1) throw new Error(`Entry ${id} not found in assigned queue`);
    assigned[idx] = { ...assigned[idx], ...patch };
    writeJsonl(ASSIGNED, assigned);
    return assigned[idx];
  });
}

/**
 * Mark an entry complete (moves from assigned → completed).
 */
function complete(id, receipt = null) {
  return withLock(() => {
    ensureDir();
    const assigned = readJsonl(ASSIGNED);
    const idx = assigned.findIndex(e => e.id === id);
    if (idx === -1) throw new Error(`Entry ${id} not found in assigned queue`);
    const entry = { ...assigned[idx], status: "completed", completed_at: new Date().toISOString(), receipt };
    assigned.splice(idx, 1);
    writeJsonl(ASSIGNED, assigned);
    appendJsonl(COMPLETED, entry);
    return entry;
  });
}

/**
 * Fail an entry (moves from assigned → completed with status=failed).
 */
function fail(id, reason) {
  return complete(id, { error: reason, failed_at: new Date().toISOString() });
}

/** Read all entries across all queues. */
function snapshot() {
  ensureDir();
  return {
    pending:   readJsonl(PENDING),
    assigned:  readJsonl(ASSIGNED),
    completed: readJsonl(COMPLETED),
  };
}

/** List only pending entries. */
function listPending()  { ensureDir(); return readJsonl(PENDING); }

/** List only assigned entries. */
function listAssigned() { ensureDir(); return readJsonl(ASSIGNED); }

module.exports = { enqueue, claimNext, updateEntry, complete, fail, snapshot, listPending, listAssigned, makeEntry };
