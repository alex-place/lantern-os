"use strict";
/**
 * command-allowlist — the ONE operator command allowlist.
 *
 * Shared by the Keystone operator console (routes/keystone.js) and the dream-chat
 * tool registry (lib/tool-runner.js) so shell execution has a single policy, not a
 * per-surface copy. Capture groups are charset-restricted (no shell metacharacters)
 * and every command runs shell-free via safeExec(tokenizeCommand(...)) (#873).
 */
const ALLOWED = [
  // Git
  { match: /^git status$/, cmd: "git status" },
  { match: /^git status --short$/, cmd: "git status --short" },
  { match: /^git diff$/, cmd: "git diff" },
  { match: /^git diff --stat$/, cmd: "git diff --stat" },
  { match: /^git log$/, cmd: "git log -n 20" },
  { match: /^git log --oneline$/, cmd: "git log --oneline -n 20" },
  { match: /^git log --oneline -\d{1,3}$/, cmd: null }, // pass through
  { match: /^git add [\w./ -]+$/, cmd: null },
  { match: /^git commit -m "[\w\s.,:'/-]+"$/, cmd: null },
  { match: /^git push[\w\s./:+-]*$/, cmd: null },
  { match: /^git fetch [\w./-]+$/, cmd: null },
  { match: /^git merge [\w./-]+ --no-edit$/, cmd: null },
  { match: /^git branch$/, cmd: "git branch" },
  { match: /^git branch -a$/, cmd: "git branch -a" },
  { match: /^git stash list$/, cmd: "git stash list" },
  { match: /^git stash push -m "[\w\s.,:'/-]+"$/, cmd: null },
  { match: /^git stash pop$/, cmd: "git stash pop" },
  { match: /^git pull[\w\s./:+-]*$/, cmd: null },
  // Tests
  { match: /^npm test$/, cmd: "node tests/run-dream-journal-tests.js api chat multiturn keystone" },
  { match: /^node tests\/test_dream_journal_api\.js$/, cmd: null },
  { match: /^node tests\/test_dream_journal_chat\.js$/, cmd: null },
  { match: /^node tests\/test_dream_chat_multiturns\.js$/, cmd: null },
  { match: /^node tests\/test_dream_journal_keystone\.js$/, cmd: null },
  { match: /^python -m pytest [\w./-]+$/, cmd: null },
  { match: /^npm run [\w:-]+$/, cmd: null },
  { match: /^node --check [\w./-]+$/, cmd: null },
  // Orchestrator
  { match: /^python src\/convergence_io_engine\.py (health|inspect|loop)$/, cmd: null },
  // File reads (read-only)
  { match: /^cat [\w./-]+\.(json|md|js|py|txt)$/, cmd: null },
  { match: /^head -\d{1,4} [\w./-]+$/, cmd: null },
  // GitHub CLI
  { match: /^gh pr list[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh pr create[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh pr view[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh issue list[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh issue create[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh issue view[\w\s./:@,="'-]*$/, cmd: null },
  // Read-only issue lookups — lets in-chat autowork ("autowork issue 1255")
  // fetch the real issue body/title instead of guessing at paths. No mutation.
  { match: /^gh issue view[\w\s./:@,="'-]*$/, cmd: null },
  { match: /^gh issue list[\w\s./:@,="'-]*$/, cmd: null },
  // Curl (API testing) — local API path only (query strings carry ?/& and are denied)
  { match: /^curl -s http:\/\/127\.0\.0\.1:4177\/[\w./-]*$/, cmd: null },
];

function resolveCommand(command) {
  for (const a of ALLOWED) {
    if (a.match.test(command)) return a.cmd || command; // use override if provided
  }
  return null; // not allowed
}

module.exports = { ALLOWED, resolveCommand };
