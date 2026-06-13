/**
 * Worktree Manager
 *
 * Creates and removes git worktrees for isolated per-issue agent work.
 * Each worktree lives under .claude/worktrees/<branch-slug>.
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");

const REPO_ROOT     = path.resolve(__dirname, "..");
const WORKTREE_BASE = path.join(REPO_ROOT, ".claude", "worktrees");

function git(cmd, opts = {}) {
  return execSync(`git -C ${JSON.stringify(REPO_ROOT)} ${cmd}`, {
    encoding: "utf8",
    ...opts,
  }).trim();
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

/**
 * Create a new worktree + branch for an issue.
 * Returns { worktreePath, branch }.
 */
function createWorktree(lane, issueNumber, issueTitle) {
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });

  const lanePrefix = lane.replace(/\/$/, ""); // e.g. "claude"
  const slug       = slugify(issueTitle);
  const branch     = `${lanePrefix}/issue-${issueNumber}-${slug}`.slice(0, 80);
  const wtPath     = path.join(WORKTREE_BASE, `${lanePrefix}-issue-${issueNumber}`);

  // Remove stale worktree dir if it exists but isn't registered
  if (fs.existsSync(wtPath)) {
    try { git(`worktree remove --force ${JSON.stringify(wtPath)}`); } catch {}
    fs.rmSync(wtPath, { recursive: true, force: true });
  }

  // Create branch from master and add worktree
  try {
    git(`branch ${JSON.stringify(branch)} master`);
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  }
  git(`worktree add ${JSON.stringify(wtPath)} ${JSON.stringify(branch)}`);

  return { worktreePath: wtPath, branch };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
function removeWorktree(worktreePath, { deleteBranch = false, branch } = {}) {
  try {
    git(`worktree remove --force ${JSON.stringify(worktreePath)}`);
  } catch {}
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  if (deleteBranch && branch) {
    try { git(`branch -D ${JSON.stringify(branch)}`); } catch {}
  }
}

/**
 * List all registered worktrees (excluding main).
 */
function listWorktrees() {
  const raw = git("worktree list --porcelain");
  const trees = [];
  let current = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) trees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    }
  }
  if (current.path) trees.push(current);
  return trees.filter(t => t.path !== REPO_ROOT);
}

module.exports = { createWorktree, removeWorktree, listWorktrees, WORKTREE_BASE };
