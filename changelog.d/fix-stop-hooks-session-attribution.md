fix(hooks): stop-hook false positives — squash-merge spent branches, session attribution, per-session state

The Stop-hook PR gate (`scripts/hooks/require-pr-before-stop.sh`) no longer
false-blocks on the two states every session on this shared checkout hits:

- **Spent branches**: the fleet squash-merges, so a fully-landed branch keeps
  commits "beyond origin/master" forever. The gate now asks GitHub (one
  `gh pr list --state all` call, fail-open, timeout-wrapped) and passes
  silently when HEAD equals a MERGED PR's head SHA — instead of demanding a
  duplicate PR whose only effect would be reverting newer master work.
- **Concurrent sessions' commits**: the gate reads the session-start HEAD
  snapshot and never blocks a session that created no commits — previously it
  demanded session A open a PR for session B's in-flight work on the same
  checkout, driving A to interfere with B's branch.
- **Re-nag loops**: each gate now blocks at most once per (session, gate,
  HEAD); repeat stops in the same state get a soft note instead of another
  block, and while commits are unpushed Gate 2 no longer double-nags for the
  same commits.

`stop-warn-uncommitted.sh` state is now per-session
(`$GIT_DIR/claude-session-state/<session_id>.*`, pruned after 7 days): a
second session's SessionStart no longer clobbers the first session's
uncommitted-files baseline, and `--snapshot` also records the session-start
HEAD the PR gate reads. New self-contained test suite:
`bash scripts/hooks/test-stop-hooks.sh` (17 scenarios, stubbed gh, throwaway
repos; all passing).
