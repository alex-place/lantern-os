### chat→autowork: resolve existing-issue references instead of filing junk (#1347)

A meta-command in chat — "autowork the oldest issue", "find issue #1342", "work the newest
issue" — was filed verbatim as a brand-new GitHub issue (junk #1344 / #1346) and the pipeline
then patched that junk issue instead of the one the user meant. The handoff sent the raw
message as `{ task }` and the server always created a fresh issue when no number was given.

- `self-edit-engine.js`: new `resolveExistingIssue(repoRoot, task)` — resolves an explicit
  `#N` / "issue N" reference (verified OPEN) or a "oldest|newest|latest … issue" superlative
  to a real open issue number via `gh`; returns `null` for genuinely novel coding requests so
  they still get a fresh tracked issue.
- `autonomous-work` + `autonomous-work/stream`: resolve an existing issue first; only call
  `createIssueFromTask` when nothing is referenced. No more junk issues, and meta-commands hit
  the right target.
- Tests: hermetic null-case coverage in `tests/test_self_edit_engine.js` (a real coding task
  is never mis-resolved onto an unrelated existing issue).

_Loop stage: Reason (don't confabulate a new Task when one already exists) + Act (work the
right target)._
