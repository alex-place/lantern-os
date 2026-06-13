/**
 * Work Dispatcher — Phase 3
 *
 * Polls pending.jsonl, finds an idle slot, creates a git worktree,
 * claims the queue entry, and returns a ready work context.
 *
 * Depends on: queue-manager (Phase 1), agent-slot-manager (Phase 2)
 */

"use strict";

const { listPending, claimNext, updateEntry } = require("./queue-manager");
const { getAllStatus, markWorking }            = require("./agent-slot-manager");
const { createWorktree }                       = require("./worktree-manager");

/**
 * Find the first idle slot that can handle the given lane.
 * A "human/" queue entry can be claimed by any enabled slot.
 */
function findIdleSlot(lane) {
  const slots = getAllStatus();
  return slots.find(s => s.status === "idle" && s.enabled !== false &&
    (s.lane === lane || lane === "human/"));
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

  // 1. Check pending work
  const pending = listPending();
  if (pending.length === 0) return null;

  // 2. Find a matching idle slot
  const candidate = pending.find(e => {
    const lane = preferredLane || e.lane;
    return findIdleSlot(lane) !== null;
  });
  if (!candidate) return null;

  const slot = findIdleSlot(preferredLane || candidate.lane);
  if (!slot) return null;

  // 3. Claim the queue entry
  const entry = claimNext(slot.lane);
  if (!entry) return null;

  // 4. Create isolated worktree + branch
  let worktreePath = null;
  let branch       = null;
  if (createTree) {
    try {
      const wt = createWorktree(slot.lane, entry.issue_number, entry.title);
      worktreePath = wt.worktreePath;
      branch       = wt.branch;
      updateEntry(entry.id, { branch, agent_id: slot.id });
    } catch (err) {
      // Worktree creation failed — update entry with error context but continue
      updateEntry(entry.id, { agent_id: slot.id, receipt: { worktree_error: err.message } });
    }
  }

  // 5. Mark slot as working
  markWorking(slot.id, entry.id);

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
  return {
    issue_number: entry.issue_number,
    issue_url:    entry.issue_url,
    title:        entry.title,
    body_excerpt: entry.body_excerpt,
    labels:       entry.labels,
    lane:         entry.lane,
    queued_at:    entry.queued_at,
    instructions: [
      `Work item: #${entry.issue_number} — ${entry.title}`,
      `Lane: ${entry.lane}`,
      `Issue: ${entry.issue_url}`,
      entry.body_excerpt ? `Context:\n${entry.body_excerpt}` : "",
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
