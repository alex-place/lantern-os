# Railway runbook: unisona.ai

Production is the Railway project **`unisona`** (service `unisona`, environment
`production`). This was verified on 2026-09-11 (#3524):
- `https://unisona.ai/api/status` reports `repoRoot: /app/apps`, Railway's container path;
- every entry in `railway deployment list` is a CLI upload or a redeploy, with no commit attached.

The GCE VM in [gce-cloud-deploy-runbook.md](gce-cloud-deploy-runbook.md) no longer
serves the site.

## How code reaches production

Railway runs **whatever was last uploaded with `railway up`**. Merging to `master`
and publishing a GitHub Release don't move it.

Build and start come from the repo:
- `railway.json`:
  - Nixpacks build, start `node apps/lantern-garage/server.js`.
  - Healthcheck `/api/status`, 120 s. It only gates a deploy going live; a running service that stops answering isn't restarted.
  - Restart on failure, 3 retries. After three crashes the service stays down until someone redeploys.
- `nixpacks.toml`: Node only, `npm ci --ignore-scripts`. The `prepare` hook needs `.git`, which isn't uploaded.
- `.railwayignore`: keeps `.git`, `node_modules`, `data/*`, models and the desktop app out of the upload.

## Deploy

```bash
node scripts/railway-deploy.mjs                         # plan: which commit would ship
node scripts/railway-deploy.mjs --yes                   # ship origin/master
node scripts/railway-deploy.mjs --ref <sha|tag> --yes   # ship, or roll back to, one commit
```

The script:
- **Refuses during the US session** (Mon–Fri 09:25–16:05 ET), because a deploy restarts the app and the app runs the users' trader. `--force` overrides this for an urgent fix.
- Ships a **clean checkout** of the commit from a throwaway worktree, so uncommitted local edits never go out. It stops if images come out as Git LFS pointer files (install git-lfs, then `git lfs pull`).
- Writes **`build-info.json`** at the upload root. `/api/version` reads it, so production names its commit instead of `unknown`.
- Waits up to 15 minutes for `https://unisona.ai/api/version` to report that commit.

It needs git, git-lfs, and the Railway CLI logged in to the project (`railway whoami`).

## Configuration and secrets

These are Railway Variables, never a file on a host:

```bash
railway variable set KEY=value --service unisona --environment production
railway redeploy --service unisona --environment production --yes
```

`variable set` triggers a deploy unless you add `--skip-deploys`. Either way a deploy restarts the users' trader, so set variables after the close.

Pass values with the argument form and trim them. A trailing newline from the dashboard or from stdin broke Google sign-in once: the URL carried `client_id=…%0A` and Google answered `invalid_client`.

## Check

```bash
curl -s https://unisona.ai/api/version
railway deployment list --service unisona --environment production
railway logs --service unisona --environment production
DEPLOY_BASE_URL=https://unisona.ai DEPLOY_EXPECT_LIVE=1 npm run test:deploy
```
