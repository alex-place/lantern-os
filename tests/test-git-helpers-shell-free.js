#!/usr/bin/env node
/**
 * test-git-helpers-shell-free.js
 *
 * Proves the shell-free conversion of the automation git() helpers:
 *   - src/worktree-manager.js  (createWorktree / listWorktrees / removeWorktree)
 *
 * Both formerly built `git ...` shell strings with interpolated input; they now
 * pass argv arrays to execFileSync (shell:false). This test exercises each
 * against a throwaway git repo and asserts:
 *   1. the real git operations still work (correctness);
 *   2. a value containing shell metacharacters ($(...), backticks, ;) is treated
 *      as literal data and never executed (injection closed).
 *
 * Run: node tests/test-git-helpers-shell-free.js   (exit 0 = pass)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const wm = require(path.join(ROOT, 'src', 'worktree-manager.js'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helpers-'));
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g(['init', '-q']);
  try { g(['checkout', '-q', '-b', 'master']); } catch { /* already on master */ }
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, g };
}

function noInjectionFiles(dir, names) {
  return names.every((n) => !fs.existsSync(path.join(dir, n)));
}

// ── worktree-manager: create / list / remove end-to-end ──────────────────
console.log('worktree-manager (create/list/remove):');
{
  const { dir } = tmpRepo();
  const evilTitle = 'add feature; touch WT_INJ $(touch WT_INJ2)';
  const { worktreePath, branch } = wm.createWorktree('claude', 7, evilTitle, dir);
  ok(fs.existsSync(worktreePath), 'worktree directory created');
  ok(noInjectionFiles(dir, ['WT_INJ', 'WT_INJ2']) && noInjectionFiles(worktreePath, ['WT_INJ', 'WT_INJ2']),
     'no shell injection from worktree title');
  const trees = wm.listWorktrees(dir);
  ok(trees.some((t) => path.basename(t.path) === path.basename(worktreePath)), 'listWorktrees sees the new worktree');
  ok(/^claude\/issue-7-/.test(branch), 'branch name slugified from title');
  wm.removeWorktree(worktreePath, { deleteBranch: true, branch, repoRoot: dir });
  ok(!fs.existsSync(worktreePath), 'worktree removed');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
