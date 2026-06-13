/**
 * GET /api/dream/status/agents
 *
 * Returns live agent slot status + queue snapshot formatted for
 * dream-chat display and JSON consumers.
 *
 * Part of Phase 4 (Dream-Chat Bridge).
 */

"use strict";

const path = require("path");
const { sendJson } = require("../lib/http-utils");

// Lazy-load orchestration modules — they may not exist in older deploys
function tryRequire(p) {
  try { return require(p); } catch { return null; }
}

const REPO_ROOT   = path.resolve(__dirname, "../../..");
const qm  = tryRequire(path.join(REPO_ROOT, "src/queue-manager"));
const asm = tryRequire(path.join(REPO_ROOT, "src/agent-slot-manager"));

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

function buildStatusPayload() {
  const slots   = asm ? asm.getAllStatus() : [];
  const snap    = qm  ? qm.snapshot()     : { pending: [], assigned: [], completed: [] };

  const pendingCount   = snap.pending.length;
  const workingCount   = snap.assigned.length;
  const completedCount = snap.completed.length;
  const totalCount     = pendingCount + workingCount + completedCount;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Per-lane summary lines
  const laneLines = slots.map(s => {
    const working = snap.assigned.find(e => e.agent_id === s.id);
    if (s.status === "working" && working) {
      const age = Date.now() - new Date(working.assigned_at).getTime();
      return `${s.lane.replace(/\/$/, "")} lane: Issue #${working.issue_number} (${working.title.slice(0, 40)}) — working ${formatDuration(age)}`;
    }
    if (s.status === "disabled") return `${s.lane.replace(/\/$/, "")} lane: Disabled`;
    if (s.status === "failed")   return `${s.lane.replace(/\/$/, "")} lane: ⚠ Failed (${s.lastError || "unknown"})`;
    return `${s.lane.replace(/\/$/, "")} lane: Ready for work`;
  });

  const queueLine = `Queue: ${pendingCount} pending · ${workingCount} working · ${completedCount} completed${pct > 0 ? ` · ${pct}% done` : ""}`;

  const nextItems = snap.pending.slice(0, 3).map(e => `  #${e.issue_number} ${e.title.slice(0, 50)}`).join("\n");

  const text = [
    ...laneLines,
    queueLine,
    nextItems ? `Next up:\n${nextItems}` : "",
  ].filter(Boolean).join("\n");

  return {
    text,
    slots,
    queue: {
      pending:   pendingCount,
      working:   workingCount,
      completed: completedCount,
      total:     totalCount,
      pct,
      next:      snap.pending.slice(0, 5).map(e => ({ number: e.issue_number, title: e.title, lane: e.lane })),
    },
    raw: { slots, snap },
  };
}

module.exports = async function agentStatusRoute(req, res, url) {
  if (url.pathname !== "/api/dream/status/agents") return false;
  if (req.method !== "GET") return false;

  if (!qm || !asm) {
    sendJson(res, {
      text: "Orchestration modules not loaded. Run convergence Phase 1-3 first.",
      slots: [],
      queue: { pending: 0, working: 0, completed: 0, total: 0, pct: 0, next: [] },
    });
    return true;
  }

  sendJson(res, buildStatusPayload());
  return true;
};
