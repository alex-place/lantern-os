# Auto-deploy: bring the stable worktree (port 4177, serves lantern-os.net via the
# Cloudflare tunnel) up to origin/master. Idempotent -- safe to run on a schedule.
#
# NOTE: this is the TRACKED REFERENCE copy. The copy that actually runs lives at
#   C:\dev\deploy-stable-from-master.ps1   (OUTSIDE the repo, on purpose)
# so the `git reset --hard` it performs can't wipe the running script mid-deploy.
# Driven by the Windows scheduled task `KeystoneAutoDeployStable` (every 5 min,
# runs as the user). Keep the two copies in sync by hand. Log: C:\dev\auto-deploy-stable.log
#
# CI/CD best practices applied:
# - Single-instance LOCK (with stale-lock takeover) so overlapping 5-min runs can't
#   double-restart / fight each other (was the source of deploy "churn").
# - CI-status GATE: checks the commit's GitHub check-runs. Advisory by default (logs
#   the state); set KEYSTONE_DEPLOY_REQUIRE_CI=1 to BLOCK deploys of failing/pending
#   commits. Off by default because this repo has known-red non-blocking checks.
# - PRE-SWAP VALIDATION: `node --check` on the entry + changed lib/routes files BEFORE
#   the server is stopped, so a syntax-broken commit is rejected with ZERO downtime
#   (disk is rolled back, the old server keeps serving).
# - Reproducible installs: `npm ci` (lockfile) when deps change, run while the server
#   is stopped so node_modules is never nuked under a live process.
# - Restart ONLY when server-side code changed; doc/data/static served fresh, no restart.
# - Health-check + automatic rollback to the previous commit on a failed boot.
# - Log rotation; -DryRun to validate without restarting.
#
# ASCII-only on purpose (Windows PowerShell 5.1 reads scripts as cp1252).
param([switch]$Force, [switch]$DryRun)

$ErrorActionPreference = 'Continue'
$STABLE = 'C:\dev\lantern-os-stable'
$PORT   = 4177
# Absolute path to the stable entry script. StartServer launches `node` with THIS path
# (not the relative 'apps/...') so every stable instance is uniquely identifiable by its
# command line -- the dev worktree and other checkouts have different absolute paths. That
# identity is what lets us reap leaked ZOMBIES (alive but no longer listening), the root
# cause of the lantern-os.net 502 churn (2026-06-27).
$ENTRY  = Join-Path $STABLE 'apps\lantern-garage\server.js'
$LOG    = 'C:\dev\auto-deploy-stable.log'
$LOCK   = 'C:\dev\auto-deploy-stable.lock'
$REPO   = 'alex-place/lantern-os'
$GARAGE = 'apps/lantern-garage'
$LOCK_STALE_MIN = 15

# --- logging (with simple rotation so the log can't grow unbounded) ---
if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 5MB)) { Move-Item $LOG "$LOG.1" -Force -ErrorAction SilentlyContinue }
function Log($m) {
  $line = "{0}  {1}" -f (Get-Date).ToString('s'), $m
  Add-Content -Path $LOG -Value $line
  Write-Host $line
}

# --- single-instance lock: prevent overlapping deploys (the churn fix) ---
function AcquireLock {
  if (Test-Path $LOCK) {
    $info = $null
    try { $info = Get-Content $LOCK -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $info = $null }
    if ($info) {
      $ageMin = ((Get-Date) - [datetime]$info.at).TotalMinutes
      $alive  = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
      if ($alive -and ($ageMin -lt $LOCK_STALE_MIN)) {
        Log "lock held by pid $($info.pid) (age $([int]$ageMin)m) -> another deploy running, skip"
        return $false
      }
      Log "stale lock (pid $($info.pid), age $([int]$ageMin)m) -> taking over"
    }
  }
  (@{ pid = $PID; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress) | Set-Content -Path $LOCK
  return $true
}
function ReleaseLock { Remove-Item $LOCK -ErrorAction SilentlyContinue }

function ServerPid {
  $c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess } else { return $null }
}
# All node PIDs running THIS stable worktree's server.js (matched by the absolute $ENTRY
# path, so the dev worktree / other checkouts are never touched), PLUS whoever currently
# owns $PORT (covers a legacy instance launched before this script passed the absolute
# path). De-duplicated.
function StableServerPids {
  $pids = @()
  $own = ServerPid; if ($own) { $pids += [int]$own }
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$ENTRY*") } |
      ForEach-Object { $pids += [int]$_.ProcessId }
  } catch { }
  return @($pids | Sort-Object -Unique)
}
function StopServer {
  # Reap the WHOLE stable fleet -- the live $PORT owner AND any leaked zombies. Leaving a
  # zombie alive (alive but not listening, e.g. after a partial shutdown that left the
  # collectors' setInterval timers running) was the root cause of the 502 churn: its
  # orphaned child services (MCP 8771/8772, trading 5050, discord) contended with the
  # freshly-started server, and a zombie still holding $PORT made the next boot EADDRINUSE
  # straight out (server.js exits on EADDRINUSE -- there is no port fallback). 2026-06-27.
  $targets = StableServerPids
  foreach ($p in $targets) { Log "stopping stable server tree PID $p"; & taskkill /PID $p /T /F 2>&1 | Out-Null }
  if (@($targets).Count -gt 0) { Start-Sleep -Seconds 2 }
}
# Reap leaked zombies WITHOUT touching the live $PORT owner -- used on the healthy
# up-to-date path so duplicates can't accumulate over time (the slow leak that built up
# to this outage). Age-gated so a server that is still booting (not yet listening) is
# left alone.
function ReapZombies {
  $own = ServerPid
  $reaped = 0
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$ENTRY*") -and ([int]$_.ProcessId -ne $own) } |
      ForEach-Object {
        $ageSec = ((Get-Date) - $_.CreationDate).TotalSeconds
        if ($ageSec -ge 45) {
          Log ("reaping leaked stable zombie PID {0} (age {1}s, not on {2})" -f $_.ProcessId, [int]$ageSec, $PORT)
          & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null
          $reaped++
        }
      }
  } catch { }
  if ($reaped -gt 0) { Start-Sleep -Seconds 1 }
}
function StartServer {
  # Hydrate User-scope API keys/config into this process so the spawned node inherits
  # them. Scheduled tasks run as the user but do NOT get the interactive User env block (#1049).
  foreach ($key in @(
    'ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY',
    'XAI_API_KEY','DISCORD_TOKEN','KALSHI_API_KEY','KALSHI_API_SECRET',
    'SESSION_SECRET','PATREON_CLIENT_ID','PATREON_CLIENT_SECRET','PATREON_CAMPAIGN_ID',
    'GEMINI_USE_VERTEX','VERTEX_PROJECT','VERTEX_LOCATION','KEYSTONE_PREFERRED_PROVIDER',
    'CHAT_TOOL_EXEC'
  )) {
    $val = [System.Environment]::GetEnvironmentVariable($key, 'User')
    if ($val) { [System.Environment]::SetEnvironmentVariable($key, $val, 'Process') }
  }
  # This machine's public tunnel is the cloudflared Windows service (LanternCloudflareTunnel);
  # the server must NOT spawn its own cloudflared (it would `tunnel run` against a Unix creds
  # path in ~/.cloudflared/config.yml that doesn't exist on Windows -> failed spawn + log spam
  # every boot). Set explicitly here so it holds even if .env.local is lost (belt-and-suspenders;
  # matches Start-DualServers.ps1).
  [System.Environment]::SetEnvironmentVariable('LANTERN_CLOUDFLARE_TUNNEL', 'false', 'Process')
  # Launch with the ABSOLUTE entry path (not relative) so StopServer/ReapZombies can
  # identify this instance later. WorkingDirectory stays $STABLE, so __dirname and
  # process.cwd() are unchanged -- behaviour is identical to the relative invocation.
  Start-Process -FilePath 'node' -ArgumentList $ENTRY -WorkingDirectory $STABLE -WindowStyle Hidden
}
function HealthOk {
  for ($i = 0; $i -lt 25; $i++) {
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$PORT/api/convergence/health" -UseBasicParsing -TimeoutSec 4
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}
function NpmCi {
  Push-Location $STABLE
  try {
    Log "deps changed -> npm ci (reproducible)"
    & npm ci --no-audit --no-fund --prefix $GARAGE 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "npm ci failed -> npm install fallback"; & npm install --no-audit --no-fund --prefix $GARAGE 2>&1 | Out-Null }
  } catch { Log "npm install error: $_" }
  Pop-Location
}
# CI-status of a commit via GitHub check-runs: success | failure | pending | unknown.
# Fetch raw JSON and parse in PowerShell -- do NOT pass a jq expression via --jq:
# PowerShell 5.1 mangles the embedded double-quotes when handing the arg to gh.exe
# (jq then errors "function not defined"). We also -join the output because PS
# captures multiline command output as a string[], which ConvertFrom-Json rejects.
function CiState($sha) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return 'unknown' }
  try {
    $raw = (& gh api "repos/$REPO/commits/$sha/check-runs" 2>$null) -join "`n"
    if (-not $raw) { return 'unknown' }
    $runs = ($raw | ConvertFrom-Json).check_runs
    if (-not $runs -or @($runs).Count -eq 0) { return 'unknown' }
    if (@($runs | Where-Object { $_.status -ne 'completed' }).Count -gt 0) { return 'pending' }
    if (@($runs | Where-Object { $_.conclusion -in @('failure','timed_out','cancelled','action_required') }).Count -gt 0) { return 'failure' }
    return 'success'
  } catch { return 'unknown' }
}

# =================== main ===================
if (-not (AcquireLock)) { exit 0 }
try {
  & git -C $STABLE fetch origin master --quiet 2>&1 | Out-Null
  $local  = (& git -C $STABLE rev-parse HEAD).Trim()
  $remote = (& git -C $STABLE rev-parse origin/master).Trim()

  if (($local -eq $remote) -and -not $Force) {
    # Self-heal (2026-06-26): code is current, but if the server has DIED, restart it
    # instead of logging "up-to-date" and leaving 4177 down. Previously a crashed-but-
    # current server only recovered when the NEXT commit landed (the gap that left
    # lantern-os.net down until a manual -Force). ServerPid/StartServer/HealthOk are
    # defined above; we're inside the single-instance lock so there is no double-start.
    if (-not (ServerPid)) {
      Log "up-to-date ($($local.Substring(0,8))) but server NOT running -> reap zombies + self-heal restart"
      ReapZombies   # clear any leaked instance still holding child-service ports before we boot a fresh one
      StartServer
      if (HealthOk) { Log "self-heal: server restarted OK on $PORT" } else { Log "self-heal FAILED: server still down on $PORT -- MANUAL ATTENTION" }
    } else {
      ReapZombies   # healthy: sweep up any leaked zombie siblings so duplicates can't accumulate (never touches the live owner)
      Log "up-to-date ($($local.Substring(0,8)))"
    }
    exit 0
  }

  Log "deploy: $($local.Substring(0,8)) -> $($remote.Substring(0,8))"

  # --- CI gate (advisory unless KEYSTONE_DEPLOY_REQUIRE_CI=1) ---
  $ci = CiState $remote
  Log "ci check-runs for $($remote.Substring(0,8)): $ci"
  if (($env:KEYSTONE_DEPLOY_REQUIRE_CI -eq '1') -and ($ci -in @('failure','pending')) -and -not $Force) {
    Log "CI gate: state=$ci -> deferring deploy (retry next run; override with -Force or KEYSTONE_DEPLOY_REQUIRE_CI=0)"
    exit 0
  }

  $changed = & git -C $STABLE diff --name-only $local $remote
  $codeRe  = '^(apps/lantern-garage/server(-dev)?\.js|apps/lantern-garage/(lib|routes)/|.*package(-lock)?\.json$)'
  $needRestart = @($changed | Where-Object { $_ -match $codeRe }).Count -gt 0
  $depsChanged = @($changed | Where-Object { $_ -match 'package(-lock)?\.json$' }).Count -gt 0

  # --- update the worktree to master (robust: reset --hard, cannot wedge) ---
  # `merge --ff-only` STALLS whenever the live server has dirtied a TRACKED file (data/
  # logs, manifests, *.csf/*.jsonl) -- the silent-stall bug where the deploy sat at
  # $local forever while logging "deployed OK" and restarting stale code on disk.
  # reset --hard always reaches master and preserves all UNTRACKED runtime data
  # (conversations/, profiles/, queue/, ...). To ALSO keep runtime APPENDS to TRACKED
  # data files that master is NOT changing this deploy, snapshot them aside and restore
  # them after the reset; files master DOES change take master's version (authoritative
  # for anything it commits).
  $changedSet = @{}; foreach ($c in $changed) { if ($c) { $changedSet[$c] = $true } }
  $dirty = @(& git -C $STABLE diff --name-only HEAD) | Where-Object { $_ }
  $preserve = @()
  foreach ($f in $dirty) {
    $isData = ($f -match '^(data/|apps/data/)' -or $f -match '\.(csf|jsonl)$')
    if ($isData -and -not $changedSet.ContainsKey($f)) { $preserve += $f }
  }
  # clear any skip-worktree flags left by earlier runs so reset --hard fully applies
  $sw = @(& git -C $STABLE ls-files -v) | Where-Object { $_ -cmatch '^[Ss] ' } | ForEach-Object { $_.Substring(2) }
  foreach ($f in $sw) {
    & git -C $STABLE update-index --no-skip-worktree -- $f 2>&1 | Out-Null
    $isData = ($f -match '^(data/|apps/data/)' -or $f -match '\.(csf|jsonl)$')
    if ($isData -and -not $changedSet.ContainsKey($f) -and ($preserve -notcontains $f)) { $preserve += $f }
  }
  # snapshot preserved runtime files aside (binary-safe copy)
  $tmp = Join-Path $env:TEMP ("deploy-preserve-" + $PID)
  if ($preserve.Count -gt 0) { New-Item -ItemType Directory -Force -Path $tmp | Out-Null }
  foreach ($f in $preserve) {
    $src = Join-Path $STABLE $f
    if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $tmp ($f -replace '[\\/]', '__')) -Force -ErrorAction SilentlyContinue }
  }

  & git -C $STABLE reset --hard origin/master --quiet 2>&1 | Out-Null

  # restore preserved runtime data (master did not change these this deploy)
  foreach ($f in $preserve) {
    $bak = Join-Path $tmp ($f -replace '[\\/]', '__')
    if (Test-Path $bak) {
      $src = Join-Path $STABLE $f
      $dir = Split-Path $src -Parent
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      Copy-Item -LiteralPath $bak -Destination $src -Force -ErrorAction SilentlyContinue
      Log "preserved runtime data across reset -> $f"
    }
  }
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

  # --- HONEST VERIFICATION: never report success on a HEAD that did not move ---
  $head = (& git -C $STABLE rev-parse HEAD).Trim()
  if ($head -ne $remote) {
    Log "DEPLOY FAILED: reset did not reach master ($($head.Substring(0,8)) != $($remote.Substring(0,8))) -- stable-server may have diverged from master. NOT restarting, NOT reporting OK. Investigate."
    exit 1
  }

  # --- PRE-SWAP VALIDATION: reject a syntax-broken commit with ZERO downtime ---
  $jsToCheck = @("$GARAGE/server.js")
  $jsToCheck += @($changed | Where-Object { $_ -match '\.js$' -and $_ -match "^$GARAGE/(lib|routes)/" })
  $bad = @()
  foreach ($f in ($jsToCheck | Select-Object -Unique)) {
    $full = Join-Path $STABLE $f
    if (Test-Path $full) {
      & node --check $full 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { $bad += $f }
    }
  }
  if ($bad.Count -gt 0) {
    Log "VALIDATION FAILED (node --check): $($bad -join ', ') -> abort; rolling disk back to $($local.Substring(0,8)); server left running"
    & git -C $STABLE reset --hard $local --quiet 2>&1 | Out-Null
    exit 1
  }

  # Server not running at all: start it (no rollback candidate).
  if (-not (ServerPid)) {
    if ($depsChanged) { NpmCi }
    Log "server not running -> starting $($remote.Substring(0,8))"
    if ($DryRun) { Log "DRY-RUN: would start server"; exit 0 }
    ReapZombies   # clear leaked zombies first so child-service ports / $PORT are free for the fresh boot
    StartServer
    if (HealthOk) { Log "server started OK on $PORT" } else { Log "server FAILED to come up on $PORT -- MANUAL ATTENTION" }
    exit 0
  }

  if (-not $needRestart) { Log "files updated, no server-side code change -> no restart ($($remote.Substring(0,8)))"; exit 0 }

  if ($DryRun) { Log "DRY-RUN: validated OK; would restart for $($remote.Substring(0,8))"; exit 0 }

  # --- swap: stop, (install deps while down so node_modules isn't nuked live), start ---
  StopServer
  if ($depsChanged) { NpmCi }
  StartServer
  if (HealthOk) { Log "deployed OK -> $($remote.Substring(0,8)); healthy on $PORT"; exit 0 }

  Log "HEALTH CHECK FAILED -> rolling back to $($local.Substring(0,8))"
  & git -C $STABLE reset --hard $local --quiet 2>&1 | Out-Null
  StopServer
  if ($depsChanged) { NpmCi }
  StartServer
  if (HealthOk) { Log "rolled back to $($local.Substring(0,8)); healthy" } else { Log "ROLLBACK ALSO UNHEALTHY on $PORT -- MANUAL ATTENTION" }
  exit 1
}
finally {
  ReleaseLock
}
