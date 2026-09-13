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
  - Nixpacks build, start `node apps/lantern-garage/start.js` (see *Website and trader as two processes* below).
  - Healthcheck `/api/status`, 120 s. It only gates a deploy going live; a running service that stops answering isn't restarted.
  - Restart ALWAYS, since #3525. It was on-failure with 3 retries, which left the service DOWN
    after the third crash — for a trader, the worst of both worlds. This is the outer net, for
    the supervisor itself; the trader's own restarts never reach it. See *Stall watchdog* below.
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

## Website and trader as two processes (#3523)

Set the Railway Variable **`LANTERN_SPLIT=1`** and `start.js` runs two processes inside the one
service, under `lib/split-supervisor.js`:
- **web** (`LANTERN_ROLE=web`) on the service's `PORT`: the site, the APIs, chat, the UI data
  collectors, MCP and the job worker. No trading loops.
- **trader** (`LANTERN_ROLE=trader`) on `127.0.0.1:4190` (`LANTERN_TRADER_PORT`): the autoscan and
  fast-exit loops, the overnight sleeve, the Sigma schedule, the brake monitor and the Kalshi
  stop-loss monitor.

They share the service's disk, so users' broker links, trader modes and tradelists stay in one
place. They don't share an event loop, so a slow chat request can't stall a scan, and one
crashing doesn't take the other down. The supervisor restarts a child that exits, 1 s, 2 s, 4 s …
up to 30 s apart. The few routes whose state lives in the trader (extended-hours switch, Kalshi
monitor, brake and Sigma status) are forwarded to it by the web process (`lib/trader-forward.js`).

Why not two Railway services: a volume attaches to one service only, and the trader needs the
same files the website writes.

Unset, `start.js` is exactly `node server.js` in one process, as it always was. A deploy still
restarts both processes, so the market-hours rule for deploys still applies.

Known limit: provider keys and the IBKR account/gateway saved through the settings API are
applied to the web process's environment. The trader picks them up at its next restart.

## Stall watchdog (#3525)

The scan loop is a self-rescheduling `setTimeout` chain: each tick queues the next one only after
the previous finishes. If a tick never finishes, the chain stops. There is no crash, no exit code
and no log line — the process stays up, `/api/status` answers 200, and nothing trades. Railway's
healthcheck cannot see this: it gates a deploy going live, not a running service, and this service
answers fine.

`lib/trader-heartbeat.js` watches for that from inside the trader process. A heartbeat is a
**completed scan cycle**, not a tick, because a wedged broker session leaves the loop ticking on
schedule while every scan throws. Stale in session → it logs, mails, and exits non-zero; the split
supervisor restarts that child in about a second.

**It is off unless you set it.** It can end the process, and the operator's armed local boxes run
this same code.

```bash
railway variable set TRADER_HEARTBEAT=1 --service unisona --environment production
railway variable set TRADER_HEARTBEAT_EMAIL=you@example.com --service unisona --environment production
```

| Variable | Default | What it does |
|---|---|---|
| `TRADER_HEARTBEAT` | unset (off) | `alert` = log + mail · `1` = log + mail + `exit(1)` |
| `TRADER_HEARTBEAT_EMAIL` | unset | Where alerts go. Unset = logged, not mailed. |
| `TRADER_HEARTBEAT_STALE_MS` | 300000 | Floor is 2x `TRADER_AUTOSCAN_MS`. |
| `TRADER_HEARTBEAT_MAX_RESTARTS` | 3 | Per rolling hour, then it only alerts. |
| `TRADER_HEARTBEAT_COOLDOWN_MS` | 900000 | Minimum gap between alert mails for one stall. |
| `TRADER_HEARTBEAT_CHECK_MS` | 60000 | How often it looks. |

Five minutes and not the two the issue asked for: the cadence is 60 s and a scan takes 45-60 s, so
a **healthy** loop is normally silent for about two minutes between completions. Two times the
cadence would page on a working trader.

Use `alert` where nothing catches the exit — that is the unsplit `all` role, which is what the
local boxes and the desktop app run. Under `LANTERN_SPLIT=1` the supervisor is the parent and
`1` is safe.

Outside market hours it is silent, and it never restarts more than `MAX_RESTARTS` times an hour:
a loop broken by a bad deploy would otherwise restart forever, and each restart drops whatever
in-memory state the trader had mid-session. The count lives in `data/trading/heartbeat.json`
precisely so it survives the exit it caused.

`railway.json` says `restartPolicyType: ALWAYS` for the same reason. It was `ON_FAILURE` with
three retries, which left the whole service **down** after the third crash. That is the outer net,
for the supervisor itself — the trader's own restarts never reach it.

Read it back on the trader's loopback port, or on `/api/status` in the unsplit role:

```bash
curl -s http://127.0.0.1:4190/api/status | jq .trader_heartbeat
```

`mode: "off"` with `scans: 0` on the **web** half is correct, not a fault: that process runs no
loop. `applyRoleEnv()` sets `TRADER_AUTOSCAN=0` for it, and the watchdog starts inside the block
that switch turns off — otherwise it would find a permanently stale heartbeat and restart the
website every five minutes.

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
