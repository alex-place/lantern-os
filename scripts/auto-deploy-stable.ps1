# Auto-deploy: bring the stable worktree (port 4177, serves lantern-os.net via the
# Cloudflare tunnel) up to origin/master. Idempotent -- safe to run on a schedule.
#
# NOTE: this is the TRACKED REFERENCE copy. The copy that actually runs lives at
#   C:\dev\deploy-stable-from-master.ps1   (OUTSIDE the repo, on purpose)
# so the `git reset --hard` it performs can't wipe the running script mid-deploy.
# Driven by the Windows scheduled task `KeystoneAutoDeployStable` (every 5 min,
# runs as the user). Keep the two copies in sync by hand. Log: C:\dev\auto-deploy-stable.log
#
# Behaviour:
# - Resets the stable worktree to origin/master (untracked runtime data preserved;
#   NO git clean).
# - Restarts the server ONLY if server-side code changed (server.js, lib/, routes/,
#   package.json). Doc/data/static changes are served fresh from disk, no restart.
# - Runs `npm install` only when package.json changed.
# - Health-checks port 4177 after a restart; on failure, rolls back to the previous
#   commit and restarts. The site is never left on a non-booting deploy.
#
# ASCII-only on purpose (Windows PowerShell 5.1 reads scripts as cp1252).
param([switch]$Force)

$ErrorActionPreference = 'Continue'
$STABLE = 'C:\dev\lantern-os-stable'
$PORT   = 4177
$LOG    = 'C:\dev\auto-deploy-stable.log'

function Log($m) {
  $line = "{0}  {1}" -f (Get-Date).ToString('s'), $m
  Add-Content -Path $LOG -Value $line
  Write-Host $line
}
function ServerPid {
  $c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess } else { return $null }
}
function StopServer {
  $p = ServerPid
  if ($p) { Log "stopping server tree PID $p"; & taskkill /PID $p /T /F 2>&1 | Out-Null; Start-Sleep -Seconds 2 }
}
function StartServer {
  Start-Process -FilePath 'node' -ArgumentList 'apps/lantern-garage/server.js' -WorkingDirectory $STABLE -WindowStyle Hidden
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

& git -C $STABLE fetch origin master --quiet 2>&1 | Out-Null
$local  = (& git -C $STABLE rev-parse HEAD).Trim()
$remote = (& git -C $STABLE rev-parse origin/master).Trim()

if ($local -eq $remote -and -not $Force) { Log "up-to-date ($($local.Substring(0,8)))"; exit 0 }

Log "deploy: $($local.Substring(0,8)) -> $($remote.Substring(0,8))"
$changed = & git -C $STABLE diff --name-only $local $remote
$codeRe  = '^(apps/lantern-garage/server(-dev)?\.js|apps/lantern-garage/(lib|routes)/|.*package\.json$)'
$needRestart = @($changed | Where-Object { $_ -match $codeRe }).Count -gt 0
$pkgChanged  = @($changed | Where-Object { $_ -match 'package\.json$' }).Count -gt 0

# Reset to master. Untracked runtime data (data/conversations, etc.) is preserved.
& git -C $STABLE reset --hard origin/master --quiet 2>&1 | Out-Null

if ($pkgChanged) {
  Log "package.json changed -> npm install"
  Push-Location $STABLE
  try { & npm install --no-audit --no-fund 2>&1 | Out-Null } catch { Log "npm install error: $_" }
  Pop-Location
}

if (-not $needRestart) {
  Log "files updated, no server-side code change -> no restart needed ($($remote.Substring(0,8)))"
  exit 0
}

StopServer
StartServer
if (HealthOk) {
  Log "deployed OK -> $($remote.Substring(0,8)); server healthy on $PORT"
  exit 0
}

Log "HEALTH CHECK FAILED after deploy -> rolling back to $($local.Substring(0,8))"
& git -C $STABLE reset --hard $local --quiet 2>&1 | Out-Null
StopServer
StartServer
if (HealthOk) { Log "rolled back to $($local.Substring(0,8)); server healthy" }
else { Log "ROLLBACK ALSO UNHEALTHY on $PORT -- MANUAL ATTENTION NEEDED" }
exit 1
