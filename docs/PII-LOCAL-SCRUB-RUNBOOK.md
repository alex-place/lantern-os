# PII Local-History Scrub — Runbook

**One-time, destructive (full history rewrite). Run only in an elevated, trading-paused
maintenance window.** `origin` is already PII-free; this scrubs the **local** repo and
its worktrees, which still carry the data in history.

## Background

Four personal financial PDFs (two U.S. Bank statements for acct …5568, a credit note,
a refund receipt) were ingested in 2026-06. They were purged from `origin/master`
(tree + full history rewrite) and a clean mirror was kept at `C:/dev/lantern-scrub.git`.
But the **local** `.git` (shared by every worktree) still has them: all local branches
descend from the contaminated commits, so only a full rewrite (or re-clone) purges them.

Current state (verify with Step 0):
- In local history — e.g. commit `b904d7bd` and ancestors.
- Staged in the `-dev` and `-work` worktrees (10 files each).
- **`origin/*` is clean** — so this is **local hygiene/debt, not an active leak**.

The 12 contaminated paths:

```
data/reports/caadi/2026-04-15 Statement - USB Alex Personal 5568.pdf
data/reports/caadi/2026-05-15 Statement - USB Alex Personal 5568.pdf
data/reports/caadi/CreditNote-E6205C63-0009-CN-01.pdf
data/reports/caadi/Refund-3177-5986.pdf
data/ingest/imagesandreports-2026-06-02/imagesandreports/<same 4 files>
data/ingest/imagesandreports-20260602/imagesandreports/<same 4 files>
```

## Preconditions (ALL required)

1. **Elevated PowerShell** ("Run as Administrator") — required to disable the SYSTEM
   scheduled tasks; without it, the watchdog tasks restart killed services mid-rewrite.
2. **Trading paused** — stop the live crypto trader first (real money). Do not start it
   again until you choose to resume.
3. **Accept downtime** — lantern-os.net (4177 via `cloudflared`) and the Discord bot go
   offline for the window.
4. No other agent/automation writing to the repo during the rewrite.

## Step 0 — Audit (read-only, safe to run anytime)

```powershell
cd C:\dev\lantern-os
git log --all --oneline -- "*5568*.pdf" "*CreditNote-*.pdf" "*Refund-3177*.pdf" | Select-Object -First 5
git -C C:\dev\lantern-os-dev  diff --cached --name-only | Select-String '5568|Statement|CreditNote|Refund-'
git -C C:\dev\lantern-os-work diff --cached --name-only | Select-String '5568|Statement|CreditNote|Refund-'
git log origin/master --oneline -- "*5568*.pdf"   # expect EMPTY (origin already clean)
```

## Step 1 — Disable autostart + watchdogs (elevated)

```powershell
$tasks = 'LanternDreamJournal','LanternChatWatchdog','LanternBackendWatchdog8766',
         'LanternCloudflareTunnel','LanternDiscordBot','Lantern-KalshiNightlyAnalysis'
$tasks | ForEach-Object { Disable-ScheduledTask -TaskName $_ }
```

## Step 2 — Stop services (trader FIRST), then confirm the repo is idle

```powershell
# Trader + trading service (money first):
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -match 'crypto_live_trader' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -match 'start-trading-service|lantern-garage[\\/]server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Bots / MCP / tunnel:
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -match 'discord_lounge_bot|mcp_server' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue

# Nothing below should reference C:\dev\lantern-os:
Get-CimInstance Win32_Process -Filter "name='node.exe' or name='python.exe'" |
  Where-Object { $_.CommandLine -match 'C:\\dev\\lantern-os' } |
  Select-Object ProcessId, CommandLine
```

## Step 3 — Remove worktrees (so the rewrite covers every ref)

> ⚠️ `--force` discards **uncommitted** changes in each worktree (mostly automation
> churn + runtime data). If any worktree holds local edits you care about, commit or
> copy them out first. Record which branch each worktree is on for Step 7.

```powershell
cd C:\dev\lantern-os
git worktree list                       # note the branch of each
git worktree remove --force C:/dev/lantern-os-dev
git worktree remove --force C:/dev/lantern-os-stable
git worktree remove --force C:/dev/lantern-os-backlog
git worktree remove --force C:/dev/lantern-os-secfix
git worktree remove --force C:/dev/lantern-os-work
Get-ChildItem C:\dev\lantern-os\.claude\worktrees -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { git worktree remove --force $_.FullName }
git worktree prune
```

## Step 4 — Rewrite history on ALL refs (`git_filter_repo` is already installed)

```powershell
cd C:\dev\lantern-os
git bundle create C:\dev\lantern-os-prescrub.bundle --all   # fallback snapshot (optional)

python -m git_filter_repo --force --invert-paths `
  --path "data/reports/caadi/2026-04-15 Statement - USB Alex Personal 5568.pdf" `
  --path "data/reports/caadi/2026-05-15 Statement - USB Alex Personal 5568.pdf" `
  --path "data/reports/caadi/CreditNote-E6205C63-0009-CN-01.pdf" `
  --path "data/reports/caadi/Refund-3177-5986.pdf" `
  --path-glob "data/ingest/imagesandreports*/imagesandreports/*5568*.pdf" `
  --path-glob "data/ingest/imagesandreports*/imagesandreports/CreditNote-*.pdf" `
  --path-glob "data/ingest/imagesandreports*/imagesandreports/Refund-*.pdf"
```

`filter-repo` deletes the `origin` remote on purpose (so you can't push rewritten
history by accident). Re-add it read-only — **do not force-push; origin is already clean**:

```powershell
git remote add origin https://github.com/alex-place/lantern-os.git
git fetch origin --prune
```

## Step 5 — Purge unreachable blobs + delete the on-disk files

```powershell
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Delete the actual PDFs (and any page-1 thumbnail renders) still on disk:
Get-ChildItem -Recurse -File -Path data -Include *.pdf,*.png |
  Where-Object { $_.Name -match '5568|CreditNote-E6205C63|Refund-3177' } |
  Remove-Item -Force
# CSF research pool / manifest may embed snippets — verify and re-pack if needed:
git log --all --oneline -- data/tesseract/research-pool.csf data/tesseract/manifest.json | Select-Object -First 3
```

## Step 6 — Verify CLEAN (both must return nothing)

```powershell
git log --all --oneline -- "*5568*.pdf" "*CreditNote-*.pdf" "*Refund-3177*.pdf"
git rev-list --all --objects | Select-String '5568|CreditNote-E6205C63|Refund-3177'
```

## Step 7 — Re-add worktrees, re-enable tasks, restart

```powershell
git worktree add C:/dev/lantern-os-dev    dev-server
git worktree add C:/dev/lantern-os-stable stable-server
# ...re-add -backlog / -secfix / -work to the branches noted in Step 3...

$tasks | ForEach-Object { Enable-ScheduledTask -TaskName $_ }
Start-ScheduledTask -TaskName LanternCloudflareTunnel
Start-ScheduledTask -TaskName LanternDreamJournal
# Restart the crypto trader manually only when you are ready to resume trading.
```

## Rollback

Before Step 5's `gc --prune=now`, recover from `C:\dev\lantern-os-prescrub.bundle`
(Step 4) or the clean mirror `C:/dev/lantern-scrub.git`. **After** the prune the rewrite
is permanent.

## After

- Local history now matches the clean `origin`.
- `origin` refs were already clean; optionally ask GitHub Support to purge cached
  unreferenced blobs server-side.
- Acct …5568 was publicly downloadable for a period — treat it as exposed (monitor;
  consider a new account number).

See also: [SECURITY.md](../SECURITY.md), and the post-ingestion guard
`scripts/Invoke-PostIngestionPurge.ps1` (prevents new ingests from re-introducing PII).
