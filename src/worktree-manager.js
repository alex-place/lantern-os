/**
 * Worktree Manager
 *
 * Creates and removes git worktrees for isolated per-issue agent work.
 * Each worktree lives under <repoRoot>/.claude/worktrees/<branch-slug>.
 *
 * `repoRoot` defaults to this checkout (resolved from __dirname) but every
 * entry point accepts an explicit root so a caller running inside one checkout
 * (e.g. the live server) can target the checkout it actually wants to branch
 * from, instead of relying on this module's install location.
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");

const REPO_ROOT     = path.resolve(__dirname, "..");

// Worktrees + their slug dirs always live under <repoRoot>/.claude/worktrees,
// which the repo's .gitignore excludes — so creating one never dirties the
// containing checkout's working tree.
function worktreeBase(repoRoot) {
  return path.join(repoRoot, ".claude", "worktrees");
}

function git(cmd, repoRoot = REPO_ROOT, opts = {}) {
  return execSync(`git -C ${JSON.stringify(repoRoot)} ${cmd}`, {
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
function createWorktree(lane, issueNumber, issueTitle, repoRoot = REPO_ROOT) {
  const base = worktreeBase(repoRoot);
  fs.mkdirSync(base, { recursive: true });

  const lanePrefix = lane.replace(/\/$/, ""); // e.g. "claude"
  const slug       = slugify(issueTitle);
  const branch     = `${lanePrefix}/issue-${issueNumber}-${slug}`.slice(0, 80);
  const wtPath     = path.join(base, `${lanePrefix}-issue-${issueNumber}`);

  // Remove stale worktree dir if it exists but isn't registered
  if (fs.existsSync(wtPath)) {
    try { git(`worktree remove --force ${JSON.stringify(wtPath)}`, repoRoot); } catch {}
    fs.rmSync(wtPath, { recursive: true, force: true });
  }

  // Create branch from origin/master (the landed/serving state), not local
  // `master`, so the worktree base includes fixes merged since this checkout
  // last pulled (#942). Best-effort fetch keeps origin/master current; fall back
  // to local master only if the remote-tracking ref can't be resolved.
  try { git(`fetch origin master`, repoRoot); } catch { /* offline — use local origin/master */ }
  let baseRef = "origin/master";
  try { git(`rev-parse --verify --quiet ${baseRef}`, repoRoot); }
  catch { baseRef = "master"; }
  try {
    git(`branch ${JSON.stringify(branch)} ${baseRef}`, repoRoot);
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  }
  git(`worktree add ${JSON.stringify(wtPath)} ${JSON.stringify(branch)}`, repoRoot);

  return { worktreePath: wtPath, branch };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
function removeWorktree(worktreePath, { deleteBranch = false, branch, repoRoot = REPO_ROOT } = {}) {
  try {
    git(`worktree remove --force ${JSON.stringify(worktreePath)}`, repoRoot);
  } catch {}
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  if (deleteBranch && branch) {
    try { git(`branch -D ${JSON.stringify(branch)}`, repoRoot); } catch {}
  }
}

/**
 * List all registered worktrees (excluding main).
 */
function listWorktrees(repoRoot = REPO_ROOT) {
  const raw = git("worktree list --porcelain", repoRoot);
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
  return trees.filter(t => t.path !== repoRoot);
}

module.exports = { createWorktree, removeWorktree, listWorktrees, worktreeBase, WORKTREE_BASE: worktreeBase(REPO_ROOT) };
