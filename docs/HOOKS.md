# Git Hooks — repo-managed, contributor-shared

The hooks that gate commits and pushes are **version-controlled** and shared by
every clone. There is no per-machine copy step and nothing to keep in sync: git is
pointed at the tracked `scripts/hooks/` directory via `core.hooksPath`, so editing a
hook in a PR changes the hook for everyone on their next pull.

## Activation

Hooks activate **automatically** from the `prepare` npm script the first time you
run `npm install` (at the repo root or in ``). If you cloned
without installing dependencies, activate them by hand — any one of:

```bash
make hooks            # or:
npm run hooks         # both run scripts/setup-hooks.mjs
bash scripts/install-hooks.sh
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-MonoworkstreamHooks.ps1
```

All of these do the same two things: set `core.hooksPath = scripts/hooks` and mark
the event-named hooks executable in git (git silently ignores a non-executable hook
on macOS/Linux). `setup-hooks.mjs` is a no-op outside a git work-tree, so it can
never break an install.

> **CI is the backstop.** Every check below also runs in CI (`.github/workflows/`),
> so a machine that skips local setup is still enforced at PR time. The hooks just
> move the failure *left* — you find out before you push, not in review. This is the
> gap that let #1975 add `kalshi-screener.html` / `reset-password.html` without a
> loop-stage justification: the sprawl check only lived in CI, and the author's fork
> had no local hook.

## What runs

| Event | Hook (`scripts/hooks/`) | Enforces |
|-------|-------------------------|----------|
| **pre-commit** | `pre-commit` | Primary-checkout master guard · per-lane workstream gate · slop scan (hardcoded secrets, debug statements, SQL-concat, `eval`/`exec`, >1000 source lines) · consolidation lint on staged files |
| **commit-msg** | `commit-msg` | Blocks slop messages (empty, < 8 chars, `wip`, `placeholder`, `temp`, …) |
| **prepare-commit-msg** | `prepare-commit-msg` | Injects a conventional-commit template on blank commits |
| **pre-push** | `pre-push` | Master-push protection · change-record/version gate · stale-clobber gate · **sprawl tripwire** · per-lane workstream gate · staleness block (> 50 behind master) · `git lfs pre-push` |
| **post-merge** | `post-merge` | Warns about stale branches + pending changelog fragments |
| **post-checkout / post-commit** | `post-checkout`, `post-commit` | Thin dispatchers that chain to any machine-local legacy hook in `.git/hooks/` (e.g. the opt-in convergence loop) so `core.hooksPath` doesn't silently disable it |

### Sprawl tripwire (pre-push)

Every **new** `public/*.html` must declare which loop stage it
strengthens, or the push is blocked:

```html
<meta name="loop-stage" content="observe|remember|reason|act|verify|converge">
<!-- or, anywhere in the file: -->
<!-- loop-stage: verify -->
```

Existing pages are grandfathered — only surfaces *added* versus `origin/master` are
checked (`node scripts/sprawl-tripwire.mjs`). This keeps scope from silently
regrowing after a cleanup (#1561).

## Bypasses

Use sparingly; each is scoped to a single `git` invocation.

| Env var | Skips |
|---------|-------|
| `SKIP_MONOWORKSTREAM=1` | Workstream + slop + sprawl (the whole monoworkstream gate) |
| `SKIP_SPRAWL_CHECK=1` | Only the new-surface loop-stage tripwire |
| `SKIP_VERSION_CHECK=1` | Only the change-record / version-bump gate |
| `SKIP_CLOBBER_CHECK=1` | Only the stale-clobber gate |
| `OVERRIDE_MERGE=1` | Master-push protection / primary-checkout master guard |

Example: `SKIP_SPRAWL_CHECK=1 git push` (you have a justified reason a new surface
has no loop stage yet).

## Troubleshooting

- **Hooks don't run.** Check `git config core.hooksPath` — it should print
  `scripts/hooks`. If empty, run `make hooks`. On a linked worktree the relative
  path resolves per-worktree, so each has its own copy.
- **Hooks don't run on macOS/Linux specifically.** The hook file isn't executable.
  `make hooks` marks them `+x` in git; a stale clone may need
  `git update-index --chmod=+x scripts/hooks/<hook>`.
- **A check is skipped with a "not found" message.** The hook degrades gracefully
  when a tool is absent: the workstream gate needs `gh`, the change-record/clobber
  gates need `python`, and the sprawl tripwire needs `node`. Install the tool (CI
  has all three) or accept that that leg only runs in CI.
- **Turn hooks off entirely.** `git config --unset core.hooksPath`.

## Additional validators (manual / optional)

Beyond the hooks above, these validators can be run by hand (some are wired into the
alternate `scripts/hooks/pre-commit-full-validation`):

```bash
python3 scripts/validate-prepush-version-changelog.py # vs origin/master
python3 scripts/validate-deployment-readiness.py
python3 scripts/validate-autoupdate-safety.py
python3 scripts/validate-agents-md.py
```
