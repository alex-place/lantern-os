fix(autowork): disable headless auto-dispatch — autowork is chat-only

The `lib/auto-dispatch.js` background daemon (started in every server instance)
that turned the top backlog issue into a draft PR every 5 min has been neutered
per the founder rule "autowork must never be headless — every run routes through
the Keystone chat UX." `start()` no longer arms a timer, `enabled()` is hard-wired
`false`, and `setEnabled(true)` is a no-op that stays disabled — so neither
`AUTO_DISPATCH=1` nor a persisted per-worktree `enabledOverride:true` can resurrect
the loop. This closes the duplicate-daemon flood in which a stale dev-worktree
process churned out draft PRs #1816–#1840 headlessly and invisibly. Autowork now
runs only from Keystone chat (`!work #N`), which streams the run into the chat
surface for live review. Strengthens the Act stage (single visible trigger path).
Existing `test/auto-dispatch-stale.test.js` still passes; added inertness assertions
verify the daemon can't be enabled by env, toggle, or state file.
