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
const { execFileSync } = require("child_process");

const REPO_ROOT     = path.resolve(__dirname, "..");

// Worktrees + their slug dirs always live under <repoRoot>/.claude/worktrees,
// which the repo's .gitignore excludes — so creating one never dirties the
// containing checkout's working tree.
function worktreeBase(repoRoot) {
  return path.join(repoRoot, ".claude", "worktrees");
}

// Shell-free: argv elements are passed discretely to execFileSync (shell:false),
// so a path or branch name can never be re-interpreted by a shell — no quoting
// needed (the old `${JSON.stringify(...)}` quoting is gone with the shell).
function git(args, repoRoot = REPO_ROOT, opts = {}) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
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
    try { git(["worktree", "remove", "--force", wtPath], repoRoot); } catch {}
    fs.rmSync(wtPath, { recursive: true, force: true });
  }

  // Create branch from origin/master (the landed/serving state), not local
  // `master`, so the worktree base includes fixes merged since this checkout
  // last pulled (#942). Best-effort fetch keeps origin/master current; fall back
  // to local master only if the remote-tracking ref can't be resolved.
  try { git(["fetch", "origin", "master"], repoRoot); } catch { /* offline — use local origin/master */ }
  let baseRef = "origin/master";
  try { git(["rev-parse", "--verify", "--quiet", baseRef], repoRoot); }
  catch { baseRef = "master"; }
  try {
    git(["branch", branch, baseRef], repoRoot);
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  }
  git(["worktree", "add", wtPath, branch], repoRoot);

  return { worktreePath: wtPath, branch };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
function removeWorktree(worktreePath, { deleteBranch = false, branch, repoRoot = REPO_ROOT } = {}) {
  try {
    git(["worktree", "remove", "--force", worktreePath], repoRoot);
  } catch {}
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  if (deleteBranch && branch) {
    try { git(["branch", "-D", branch], repoRoot); } catch {}
  }
}

/**
 * Return true if `ref` (a commit) is already contained in origin/master —
 * i.e. the worktree's branch has fully landed. Best-effort: any git error
 * (missing ref, no remote) counts as "not merged" so we never remove on doubt.
 */
function isMergedToMaster(ref, repoRoot = REPO_ROOT) {
  const base = (() => {
    try { git(["rev-parse", "--verify", "--quiet", "origin/master"], repoRoot); return "origin/master"; }
    catch { return "master"; }
  })();
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ref, base],
      { stdio: "ignore" });
    return true;   // exit 0 → ref is an ancestor of base
  } catch {
    return false;  // exit 1 (not ancestor) or any error
  }
}

/**
 * Reclaim stale per-issue worktrees under <repoRoot>/.claude/worktrees.
 *
 * These accumulate because a crashed autowork run, an interactive agent
 * session, or a workflow scratch tree can exit without calling its own
 * cleanup — and because they live *inside* the repo root, every local
 * grep/Glob then scans N copies of the tree (the #2308 drag).
 *
 * Conservative by construction: a worktree is removed ONLY when its branch is
 * fully merged into origin/master AND its working tree is clean (no staged,
 * unstaged, or untracked changes). Anything unmerged or dirty is reported and
 * kept, so in-flight work from a concurrent session is never destroyed. The
 * branch is preserved on removal (the merged commits already live on master).
 *
 * @returns {{ removed: string[], keptDirty: string[], keptUnmerged: string[] }}
 */
function pruneStaleWorktrees(repoRoot = REPO_ROOT, { dryRun = false } = {}) {
  const report = { removed: [], keptDirty: [], keptUnmerged: [] };
  // Drop admin entries whose directory was already deleted by hand.
  try { git(["worktree", "prune"], repoRoot); } catch {}

  const base = worktreeBase(repoRoot);
  for (const wt of listWorktrees(repoRoot)) {
    // Only touch trees under this checkout's .claude/worktrees — never the
    // sibling server checkouts or another repo's trees.
    const inBase = path.resolve(wt.path).startsWith(path.resolve(base) + path.sep);
    if (!inBase || !wt.head) continue;
    if (!fs.existsSync(wt.path)) continue;

    let dirty = true;
    try { dirty = git(["status", "--porcelain"], wt.path).length > 0; } catch {}
    if (dirty) { report.keptDirty.push(wt.path); continue; }

    if (!isMergedToMaster(wt.head, repoRoot)) { report.keptUnmerged.push(wt.path); continue; }

    if (!dryRun) {
      removeWorktree(wt.path, { deleteBranch: false, branch: wt.branch, repoRoot });
    }
    report.removed.push(wt.path);
  }
  return report;
}

/**
 * List all registered worktrees (excluding main).
 */
function listWorktrees(repoRoot = REPO_ROOT) {
  const raw = git(["worktree", "list", "--porcelain"], repoRoot);
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

module.exports = {
  createWorktree, removeWorktree, listWorktrees, pruneStaleWorktrees, isMergedToMaster,
  worktreeBase, WORKTREE_BASE: worktreeBase(REPO_ROOT),
};

// CLI: `node src/worktree-manager.js prune [--dry-run]` reclaims merged+clean
// worktrees under this checkout. Default is a real prune; --dry-run only reports.
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "prune") {
    const dryRun = process.argv.includes("--dry-run");
    const r = pruneStaleWorktrees(REPO_ROOT, { dryRun });
    const out = (line) => process.stdout.write(line + "\n");
    const tag = dryRun ? "[dry-run] would remove" : "removed";
    out(`${tag} ${r.removed.length} merged+clean worktree(s):`);
    for (const p of r.removed) out("  - " + p);
    if (r.keptDirty.length)    out(`kept ${r.keptDirty.length} (uncommitted changes):`);
    for (const p of r.keptDirty)    out("  ~ " + p);
    if (r.keptUnmerged.length) out(`kept ${r.keptUnmerged.length} (branch not merged):`);
    for (const p of r.keptUnmerged) out("  ! " + p);
  } else {
    console.error("usage: node src/worktree-manager.js prune [--dry-run]");
    process.exit(1);
  }
}
