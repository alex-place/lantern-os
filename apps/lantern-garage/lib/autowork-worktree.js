/**
 * Autowork worktree isolation.
 *
 * Each autonomous run gets its own git worktree under <mainRoot>/.claude/worktrees
 * so every branch / apply / commit / push happens off the live serving checkout.
 *
 * Why this exists: the server runs out of the same checkout it would otherwise
 * branch in, and it continuously writes runtime JSONL (prices, chat responses,
 * metrics) into that working tree. The old in-place flow therefore tripped its
 * own `git_tree_dirty` guard ("refusing to switch branches … would be clobbered")
 * before it could branch — so autowork could never start. A dedicated worktree
 * sidesteps that entirely and also isolates concurrent issue runs from each other.
 *
 * `.claude/worktrees/` is gitignored, so creating the worktree does not dirty the
 * serving tree either.
 */

"use strict";

const path = require("path");
const { createWorktree, removeWorktree } = require("../../../src/worktree-manager");

/**
 * Create an isolated worktree for an autonomous run.
 *
 * Lane is "auto" so the branch is `auto/issue-<n>-<slug>`, which satisfies
 * self-edit-engine's `auto/`-prefix push/PR guard.
 *
 * @param {string} mainRoot     the serving checkout root (REPO_ROOT) to branch from
 * @param {number} issueNumber
 * @param {string} issueTitle
 * @returns {{ workRoot: string, branch: string, cleanup: () => void }}
 *   `cleanup()` removes the worktree directory; the branch is kept (it may have
 *   been pushed). Safe to call more than once.
 */
function createIssueWorktree(mainRoot, issueNumber, issueTitle) {
  const { worktreePath, branch } = createWorktree(
    "auto", issueNumber, issueTitle || `issue-${issueNumber}`, mainRoot);
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { removeWorktree(worktreePath, { deleteBranch: false, branch, repoRoot: mainRoot }); }
    catch (_e) { /* best effort — a stale dir is reclaimed on the next run */ }
  };
  return { workRoot: worktreePath, branch, cleanup };
}

/**
 * Environment for running the allowlisted tests inside a worktree: a fresh
 * worktree has no node_modules of its own, so point NODE_PATH at the main
 * checkout's modules to resolve any package deps the tests import.
 */
function worktreeTestEnv(mainRoot) {
  return { ...process.env, NODE_PATH: path.join(mainRoot, "node_modules") };
}

module.exports = { createIssueWorktree, worktreeTestEnv };
