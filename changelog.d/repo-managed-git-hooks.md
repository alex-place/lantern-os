chore(hooks): repo-managed git hooks + sprawl tripwire runs locally, not just in CI

The git hooks are now **repo-managed and shared by every clone** instead of being
copied per-machine by a Windows-only installer. `core.hooksPath` points git at the
tracked `scripts/hooks/` directory (new `scripts/setup-hooks.mjs`), so a hook edit
takes effect for everyone on their next pull with no reinstall, and the tracked
hooks are marked executable in git (git ignores non-executable hooks on
macOS/Linux). Setup runs automatically from a `prepare` npm script on `npm install`
(root and `apps/lantern-garage`), plus `make hooks` / `npm run hooks`; both
installers (`install-hooks.sh`, `Install-MonoworkstreamHooks.ps1`) now set
`core.hooksPath` rather than copying, unifying two previously-divergent installers.

The **sprawl tripwire** (`scripts/sprawl-tripwire.mjs`, #1561) is now enforced in the
`pre-push` hook — a new `apps/lantern-garage/public/*.html` without a `loop-stage`
justification is blocked before it reaches a PR, the exact gap that let #1975's
`kalshi-screener.html` / `reset-password.html` slip past to CI review (a fork
contributor had no local hook). Bypass: `SKIP_SPRAWL_CHECK=1 git push`.

New `post-checkout` / `post-commit` dispatchers chain to any machine-local legacy
hook in `.git/hooks/` so the `core.hooksPath` switch doesn't silently disable an
opt-in convergence loop. Adds the missing `docs/HOOKS.md` (a live reference AGENTS.md
already linked to) and updates CLAUDE.md / AGENTS.md. Strengthens the **Verify**
stage (contribution gating). Covered by `apps/lantern-garage/test/git-hooks-repo-managed.test.js`.
