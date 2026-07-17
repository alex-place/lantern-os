### Fixed

- ops: stop agent sessions from branch-switching the human's primary checkout (2026-07-16 incident — an agent ran `git stash` + `git checkout` on the main tree, switching active trading WIP out from under the operator and sweeping untracked runtime data).
  - **MCP `local_git_create_branch` now refuses a dirty primary checkout** (`git_tree_dirty` error pointing at `local_worktree_create`), mirroring the existing `self-edit-engine.js` guard.
  - **`post-checkout` hook tripwire**: git has no blocking pre-checkout hook, so the repo hook now detects an agent session (`CLAUDECODE=1`) completing a branch checkout on the primary tree (never linked worktrees, never file checkouts, never humans), prints a loud switch-back-and-use-a-worktree warning (agents read hook output as feedback), and appends an audit line to `data/ops/main-tree-checkouts.jsonl`.
  - **AGENTS.md**: explicit "never branch-switch the primary checkout" rule in the worktree-architecture section.
  - Verified: hook fires exactly in the agent+main-tree+branch case (4-scenario matrix), MCP guard refuses dirty / allows clean.
