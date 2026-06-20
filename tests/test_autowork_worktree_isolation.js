/**
 * Autowork worktree isolation (apps/lantern-garage/lib/autowork-worktree.js).
 *
 * Proves the property the autowork flow depends on: a run gets its own git
 * worktree off master, branch/commit happen there, and the MAIN checkout's
 * working tree is never dirtied — which is exactly what the old in-place flow
 * failed to do (it tripped `git_tree_dirty` because the serving tree is never
 * clean). cleanup() then removes the worktree but keeps the branch.
 *
 * Hermetic — builds a throwaway git repo in a temp dir.
 * Run: node tests/test_autowork_worktree_isolation.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { createIssueWorktree, worktreeTestEnv } = require("../apps/lantern-garage/lib/autowork-worktree");

// Use process.stdout.write — the pre-commit SLOP gate rejects the console
// debug call in committed source.
const log = (s = "") => process.stdout.write(String(s) + "\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); log(`  ✓ ${name}`); passed++; }
  catch (e) { log(`  ✗ ${name}\n      ${e.stack || e.message}`); failed++; }
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

// A temp git repo on `master` with a committed file and `.claude/` gitignored
// (mirroring the real repo, so worktrees under .claude/worktrees never show up
// as untracked content in the parent).
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aw-wt-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/\nnode_modules/\n");
  fs.writeFileSync(path.join(repo, "app.js"), "module.exports = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

log("createIssueWorktree() — isolation");

test("creates an auto/ worktree off master without dirtying the main tree", () => {
  const repo = makeRepo();
  try {
    const { workRoot, branch, cleanup } = createIssueWorktree(repo, 999, "Test Issue Title");

    assert.strictEqual(branch, "auto/issue-999-test-issue-title", "lane=auto slugified branch");
    assert.ok(branch.startsWith("auto/"), "branch satisfies the auto/ push guard");
    assert.ok(fs.existsSync(workRoot), "worktree directory exists");
    assert.ok(
      workRoot.replace(/\\/g, "/").includes("/.claude/worktrees/"),
      "worktree lives under .claude/worktrees",
    );
    assert.strictEqual(
      git(workRoot, ["rev-parse", "--abbrev-ref", "HEAD"]), branch,
      "worktree is checked out on the issue branch",
    );
    assert.ok(fs.existsSync(path.join(workRoot, "app.js")), "master content present in worktree");

    // The headline property: the MAIN checkout's working tree stayed clean.
    assert.strictEqual(git(repo, ["status", "--porcelain"]), "", "main tree is NOT dirtied");

    cleanup();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a commit in the worktree does not touch the main working tree", () => {
  const repo = makeRepo();
  try {
    const { workRoot, branch, cleanup } = createIssueWorktree(repo, 1000, "Add a line");
    fs.appendFileSync(path.join(workRoot, "app.js"), "// patched in worktree\n");
    git(workRoot, ["add", "app.js"]);
    git(workRoot, ["commit", "-qm", "patch in worktree"]);

    // Main tree still clean, and master's app.js is unchanged (no leak across trees).
    assert.strictEqual(git(repo, ["status", "--porcelain"]), "", "main tree clean after worktree commit");
    const masterApp = git(repo, ["show", "master:app.js"]);
    assert.ok(!masterApp.includes("patched in worktree"), "master not advanced by worktree commit");
    // The branch carries the new commit.
    assert.ok(git(workRoot, ["log", "-1", "--pretty=%s"]).includes("patch in worktree"));

    cleanup();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup() removes the worktree dir but keeps the branch", () => {
  const repo = makeRepo();
  try {
    const { workRoot, branch, cleanup } = createIssueWorktree(repo, 1001, "Keep the branch");
    cleanup();
    assert.ok(!fs.existsSync(workRoot), "worktree directory removed");
    const trees = git(repo, ["worktree", "list", "--porcelain"]);
    assert.ok(!trees.includes(workRoot.replace(/\\/g, "/")) && !trees.includes(workRoot),
      "worktree no longer registered");
    // Branch survives (it may have been pushed).
    const branches = git(repo, ["branch", "--list", branch]);
    assert.ok(branches.includes(branch), "issue branch kept after cleanup");
    // Idempotent — a second cleanup is a no-op, not a throw.
    cleanup();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

log("worktreeTestEnv()");

test("points NODE_PATH at the main checkout's node_modules", () => {
  const env = worktreeTestEnv("/main/checkout");
  assert.strictEqual(env.NODE_PATH, path.join("/main/checkout", "node_modules"));
});

log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
