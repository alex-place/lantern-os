/**
 * Agent Slot Manager — Phase 2
 *
 * Loads agent slot config from ~/.claude/agent-slots.json,
 * tracks per-slot status (idle / working / failed), runs heartbeat
 * monitoring, handles retries, and cleans up stale work.
 *
 * Depends on: src/queue-manager.js (Phase 1)
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { updateEntry, fail, listAssigned } = require("./queue-manager");

// ── Config ────────────────────────────────────────────────────────────────────

const SLOTS_FILE   = process.env.AGENT_SLOTS_FILE || path.join(os.homedir(), ".claude", "agent-slots.json");
const HEARTBEAT_MS = 30_000;
const STALE_MS     = 5 * 60_000; // work assigned >5 min with no heartbeat → stale

// ── State ─────────────────────────────────────────────────────────────────────

// slotId → { config, status, retries, currentEntryId, lastHeartbeat, lastError }
const _slots = new Map();
let _heartbeatTimer = null;

// ── Loader ────────────────────────────────────────────────────────────────────

function loadSlots(overridePath) {
  const file = overridePath || SLOTS_FILE;
  if (!fs.existsSync(file)) {
    throw new Error(`agent-slots.json not found at ${file}. Create it from the template in docs.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw.slots)) throw new Error("agent-slots.json must have a 'slots' array");

  for (const cfg of raw.slots) {
    if (!cfg.id || !cfg.lane) throw new Error(`Slot missing id or lane: ${JSON.stringify(cfg)}`);
    if (!_slots.has(cfg.id)) {
      _slots.set(cfg.id, {
        config:         cfg,
        status:         cfg.enabled ? "idle" : "disabled",
        retries:        0,
        currentEntryId: null,
        lastHeartbeat:  Date.now(),
        lastError:      null,
      });
    }
  }
  return [..._slots.values()].map(s => ({ id: s.config.id, lane: s.config.lane, status: s.status }));
}

// ── Status API ────────────────────────────────────────────────────────────────

function getSlot(id) {
  const s = _slots.get(id);
  if (!s) throw new Error(`Unknown slot: ${id}`);
  return s;
}

function getStatus(id) {
  return getSlot(id).status;
}

function getAllStatus() {
  return [..._slots.entries()].map(([id, s]) => ({
    id,
    lane:           s.config.lane,
    label:          s.config.label,
    enabled:        s.config.enabled,
    status:         s.status,
    retries:        s.retries,
    currentEntryId: s.currentEntryId,
    lastHeartbeat:  s.lastHeartbeat,
    lastError:      s.lastError,
  }));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Mark a slot as working on a queue entry.
 */
function markWorking(slotId, entryId) {
  const s = getSlot(slotId);
  if (s.status === "disabled") throw new Error(`Slot ${slotId} is disabled`);
  s.status         = "working";
  s.currentEntryId = entryId;
  s.lastHeartbeat  = Date.now();
  s.lastError      = null;
  updateEntry(entryId, { agent_id: slotId });
}

/**
 * Record a heartbeat — called by the worker to signal it's alive.
 */
function heartbeat(slotId) {
  const s = getSlot(slotId);
  s.lastHeartbeat = Date.now();
}

/**
 * Mark a slot idle after completing work.
 */
function markIdle(slotId) {
  const s = getSlot(slotId);
  s.status         = "idle";
  s.currentEntryId = null;
  s.retries        = 0;
  s.lastHeartbeat  = Date.now();
  s.lastError      = null;
}

/**
 * Mark a slot failed. If retries remain, resets to idle for retry.
 * Returns { retry: true } or { retry: false, exhausted: true }.
 */
function markFailed(slotId, reason) {
  const s = getSlot(slotId);
  s.lastError = reason;
  s.retries  += 1;

  const maxRetries = s.config.max_retries ?? 3;
  if (s.retries < maxRetries) {
    s.status         = "idle"; // eligible for retry
    s.currentEntryId = null;
    return { retry: true, attempt: s.retries, max: maxRetries };
  }

  // Exhausted — fail the queue entry and disable slot temporarily
  if (s.currentEntryId) {
    try { fail(s.currentEntryId, `slot ${slotId} exhausted retries: ${reason}`); } catch {}
  }
  s.status         = "failed";
  s.currentEntryId = null;
  return { retry: false, exhausted: true, attempts: s.retries };
}

/**
 * Reset a failed slot back to idle (e.g. after manual intervention).
 */
function resetSlot(slotId) {
  const s = getSlot(slotId);
  s.status         = s.config.enabled ? "idle" : "disabled";
  s.retries        = 0;
  s.currentEntryId = null;
  s.lastError      = null;
  s.lastHeartbeat  = Date.now();
}

// ── Stale work cleanup ────────────────────────────────────────────────────────

/**
 * Scan assigned entries; any where the owning slot hasn't heartbeated
 * within STALE_MS gets failed and the slot reset.
 */
function cleanupStale() {
  const staleIds = [];
  for (const [id, s] of _slots) {
    if (s.status !== "working") continue;
    const age = Date.now() - s.lastHeartbeat;
    const timeout = s.config.idle_timeout_ms || STALE_MS;
    if (age > timeout) {
      staleIds.push({ slotId: id, entryId: s.currentEntryId, age });
    }
  }

  for (const { slotId, entryId, age } of staleIds) {
    if (entryId) {
      try { fail(entryId, `stale: slot ${slotId} silent for ${Math.round(age / 1000)}s`); } catch {}
    }
    resetSlot(slotId);
  }
  return staleIds;
}

// ── Heartbeat monitor ─────────────────────────────────────────────────────────

function startHeartbeatMonitor(intervalMs = HEARTBEAT_MS) {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    const stale = cleanupStale();
    if (stale.length > 0) {
      console.warn(`[slot-manager] Cleaned ${stale.length} stale slot(s):`, stale.map(s => s.slotId));
    }
  }, intervalMs);
  if (_heartbeatTimer.unref) _heartbeatTimer.unref(); // don't keep process alive
}

function stopHeartbeatMonitor() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadSlots,
  getStatus,
  getAllStatus,
  markWorking,
  markIdle,
  markFailed,
  resetSlot,
  heartbeat,
  cleanupStale,
  startHeartbeatMonitor,
  stopHeartbeatMonitor,
};
