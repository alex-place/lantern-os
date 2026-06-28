/**
 * Regression: autowork's openDraftPr must derive the PR `head` owner from the push
 * remote, not from the base repo (#1358). gitPush() pushes `auto/*` branches to
 * `origin` (a fork); creating the PR with a bare `head=<branch>` (or the base owner)
 * makes GitHub look for the branch on the BASE repo → HTTP 422 "Validation Failed".
 *
 * Run: node tests/test_autowork_pr_head.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pushRemoteOwner } =
  require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "self-edit-engine"));

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

// 1. Explicit override wins (no git call).
process.env.AUTOWORK_HEAD_OWNER = "override-owner";
assert.strictEqual(pushRemoteOwner(process.cwd()), "override-owner");
delete process.env.AUTOWORK_HEAD_OWNER;
ok("AUTOWORK_HEAD_OWNER override is honored");

const tmpDirs = [];
function tmpRepo(originUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-prhead-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  return dir;
}

// 2. https fork origin → fork owner (the #1358 case)
assert.strictEqual(
  pushRemoteOwner(tmpRepo("https://github.com/kriskin9-hash/lantern-os.git")),
  "kriskin9-hash"
);
ok("https fork origin → fork owner (the head the PR must target)");

// 3. ssh origin → owner
assert.strictEqual(
  pushRemoteOwner(tmpRepo("git@github.com:some-fork/lantern-os.git")),
  "some-fork"
);
ok("ssh origin → fork owner");

// 4. URL without a .git suffix
assert.strictEqual(
  pushRemoteOwner(tmpRepo("https://github.com/no-suffix-owner/repo")),
  "no-suffix-owner"
);
ok("origin URL without .git suffix → owner");

// 5. no origin remote → falls back to the base owner (assume same-repo, never throws)
const noRemote = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-prhead-bare-"));
tmpDirs.push(noRemote);
execFileSync("git", ["init", "-q"], { cwd: noRemote });
assert.strictEqual(pushRemoteOwner(noRemote), "alex-place");
ok("no origin remote → falls back to base owner (alex-place), no throw");

tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
console.log(`\nAll ${passed} autowork-pr-head assertions passed.`);
