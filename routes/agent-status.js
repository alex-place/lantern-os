/**
 * GET /api/dream/status/agents
 *
 * Returns live agent slot + queue status formatted for dream-chat display.
 * Uses the class-based QueueManager / AgentSlotManager API.
 */

"use strict";

const path = require("path");
const { sendJson } = require("../lib/http-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const QUEUE_DIR = path.join(REPO_ROOT, "data", "agent-work-queue");
const SLOTS_CFG = path.join(process.env.HOME || process.env.USERPROFILE, ".claude", "agent-slots.json");

function tryLoad(mod, ...args) {
  try {
    const Cls = require(mod);
    return new Cls(...args);
  } catch {
    return null;
  }
}

async function buildStatusPayload() {
  const QueueManager     = require(path.join(REPO_ROOT, "src/queue-manager"));
  const AgentSlotManager = require(path.join(REPO_ROOT, "src/agent-slot-manager"));

  const qm  = new QueueManager(QUEUE_DIR);
  const asm = new AgentSlotManager(SLOTS_CFG);

  // Queue snapshot via class API
  const [pending, assigned, completed, failed] = await Promise.all([
    qm.listByStatus("pending"),
    qm.listByStatus("assigned"),
    qm.listByStatus("completed"),
    qm.listByStatus("failed"),
  ]);

  const pendingCount   = pending.length;
  const workingCount   = assigned.length;
  const completedCount = completed.length;
  const totalCount     = pendingCount + workingCount + completedCount;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Slot summary via class API
  const slots = asm.getEnabledSlots();

  function fmt(ms) {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3600_000)}h`;
  }

  // Resolve a slot's lane from whichever field the config actually provides.
  // agent-slots.json defines slots with `prefix`/`id` and no `lane`, so reading
  // `s.lane` directly throws "Cannot read properties of undefined (reading 'replace')"
  // the moment any slot is enabled+working (#836).
  const laneOf = (s) => String(s.lane || s.prefix || s.id || "").replace(/\/$/, "");

  const laneLines = slots.map(s => {
    const working = assigned.find(e => e.assignedTo === s.id);
    if (s.status === "working" && working) {
      const age = Date.now() - new Date(working.assignedAt).getTime();
      return `${laneOf(s)} lane: Issue #${working.issueNumber} — working ${fmt(age)}`;
    }
    if (!s.enabled) return `${laneOf(s)} lane: Disabled`;
    return `${laneOf(s)} lane: Ready`;
  });

  const stats = asm.getStats();
  const queueLine = `Queue: ${pendingCount} pending · ${workingCount} working · ${completedCount} done · ${stats.successRate > 0 ? Math.round(stats.successRate * 100) + "% success" : "no history"}`;
  const nextItems = pending.slice(0, 3).map(e => `  #${e.issueNumber} ${(e.title || "").slice(0, 50)}`).join("\n");

  const text = [
    ...laneLines,
    queueLine,
    nextItems ? `Next up:\n${nextItems}` : "",
  ].filter(Boolean).join("\n");

  return {
    text,
    slots: slots.map(s => ({ id: s.id, lane: laneOf(s), status: s.status, enabled: s.enabled })),
    queue: {
      pending: pendingCount,
      working: workingCount,
      completed: completedCount,
      total: totalCount,
      pct,
      next: pending.slice(0, 5).map(e => ({ number: e.issueNumber, title: e.title })),
    },
    stats,
  };
}

module.exports = async function agentStatusRoute(req, res, url) {
  if (url.pathname !== "/api/dream/status/agents") return false;
  if (req.method !== "GET") return false;

  try {
    const payload = await buildStatusPayload();
    sendJson(res, payload);
  } catch (err) {
    sendJson(res, {
      text: `Agent status unavailable: ${err.message}`,
      slots: [],
      queue: { pending: 0, working: 0, completed: 0, total: 0, pct: 0, next: [] },
    });
  }
  return true;
};
