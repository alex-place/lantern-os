/**
 * Work Dispatcher — Phase 3
 *
 * Polls pending.jsonl, finds an idle slot, creates a git worktree,
 * claims the queue entry, and returns a ready work context.
 *
 * Depends on: queue-manager (Phase 1), agent-slot-manager (Phase 2)
 */

"use strict";

const path            = require("path");
const QueueManager    = require("./queue-manager");
const AgentSlotManager = require("./agent-slot-manager");
const { createWorktree } = require("./worktree-manager");

const REPO_ROOT  = path.resolve(__dirname, "..");
const _queue     = new QueueManager(path.join(REPO_ROOT, "data", "agent-work-queue"));
const _slots     = new AgentSlotManager();

/**
 * Find the first idle slot that can handle the given lane.
 */
function findIdleSlot(lane) {
  const slots = _slots.getEnabledSlots();
  return slots.find(s =>
    s.status === "idle" && (s.lane === lane || lane === "human/" || !lane)
  ) || null;
}

/**
 * Dispatch one unit of work.
 *
 * @param {string} [preferredLane] — constrain to a specific agent lane
 * @param {object} [opts]
 * @param {boolean} [opts.createTree=true] — create a git worktree for the work
 * @returns {{ entry, slot, worktreePath, branch } | null}
 */
async function dispatchOne(preferredLane, opts = {}) {
  const { createTree = true } = opts;

  // 1. Find an idle slot
  const slot = findIdleSlot(preferredLane);
  if (!slot) return null;

  // 2. Claim next pending work item
  const entry = await _queue.getNextWork(slot.id);
  if (!entry) return null;

  // 3. Create isolated worktree + branch
  let worktreePath = null;
  let branch       = null;
  if (createTree) {
    try {
      const wt = createWorktree(
        slot.lane || preferredLane || "claude/",
        entry.issueNumber || entry.issue_number,
        entry.title
      );
      worktreePath = wt.worktreePath;
      branch       = wt.branch;
    } catch (err) {
      // Worktree creation failed — continue without it
    }
  }

  // 4. Mark slot as working
  try { _slots.assignWork(slot.id, entry); } catch {}

  return {
    entry,
    slot,
    worktreePath,
    branch,
    context: buildWorkContext(entry),
  };
}

/**
 * Build a work context object the agent can act on.
 */
function buildWorkContext(entry) {
  const num  = entry.issueNumber || entry.issue_number;
  const url  = entry.issueUrl    || entry.issue_url    || `https://github.com/alex-place/lantern-os/issues/${num}`;
  const lane = entry.lane        || entry.agentId      || "claude/";
  return {
    issue_number: num,
    issue_url:    url,
    title:        entry.title,
    body_excerpt: entry.body || entry.body_excerpt || "",
    labels:       entry.labels || [],
    lane,
    queued_at:    entry.queuedAt || entry.queued_at,
    instructions: [
      `Work item: #${num} — ${entry.title}`,
      `Lane: ${lane}`,
      `Issue: ${url}`,
      entry.body ? `Context:\n${entry.body.slice(0, 500)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

/**
 * Poll loop — dispatch work until queue empty or no idle slots.
 * Calls onDispatch(workItem) for each dispatched item.
 */
async function dispatchAll(onDispatch, opts = {}) {
  const dispatched = [];
  let item;
  while ((item = await dispatchOne(opts.lane, opts)) !== null) {
    dispatched.push(item);
    if (onDispatch) await onDispatch(item);
  }
  return dispatched;
}

module.exports = { dispatchOne, dispatchAll, buildWorkContext };
