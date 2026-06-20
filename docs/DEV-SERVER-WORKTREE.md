# Dev server runs from a dedicated worktree

**Why:** the autonomous automation does `git checkout` / `git reset --hard origin/master` on the **main checkout** (`C:\dev\lantern-os`) between turns (see the session memory). When the 4178 dev server runs from the main checkout, those resets/branch-switches yank code and env out from under it mid-test — causing stale-code replies and intermittent "No AI providers" failures.

**Fix:** the `lantern-dev` launch config (`.claude/launch.json`) now runs from an **isolated worktree** the automation never touches, reached via a `.dev-worktree` junction inside the project root (the preview tool requires in-project paths).

## One-time setup (this machine)
```sh
# 1. Dedicated worktree pinned to its own branch (automation only touches the MAIN tree)
git worktree add C:/dev/lantern-os-dev -b dev-server origin/master

# 2. Give it the local env + share installed deps (node_modules is gitignored, not checked out)
cp C:/dev/lantern-os/.env.local C:/dev/lantern-os-dev/.env.local
# PowerShell (junctions, no admin needed):
New-Item -ItemType Junction -Path C:/dev/lantern-os-dev/apps/lantern-garage/node_modules -Target C:/dev/lantern-os/apps/lantern-garage/node_modules
New-Item -ItemType Junction -Path C:/dev/lantern-os/.dev-worktree                        -Target C:/dev/lantern-os-dev
```
`.claude/launch.json` → `lantern-dev` points at `.dev-worktree` (cwd) so `preview_start lantern-dev` runs the stable worktree server on 4178.

## Update its code (deliberate, not automatic)
```sh
git -C C:/dev/lantern-os-dev fetch origin
git -C C:/dev/lantern-os-dev reset --hard origin/master
# then restart the dev server (preview_stop + preview_start lantern-dev)
```
Because it's a separate branch/worktree, it only moves when you run the above — the automation's churn on the main checkout can't disturb it.

> `.dev-worktree/` is gitignored so the junction never shows as working-tree churn.
