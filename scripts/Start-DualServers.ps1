<#
.SYNOPSIS
    Lantern OS Dual-Boot Quickstart (worktree-based).
    Runs two servers from their own dedicated git worktrees:
      :4177 stable / public  <-  C:\dev\lantern-os-stable   (Cloudflare tunnel)
      :4178 dev   / local    <-  C:\dev\lantern-os-dev       (server-dev.js, loopback)

.DESCRIPTION
    Each server runs from a dedicated worktree, NOT the main checkout. The
    autonomous automation does `git checkout` / `git reset --hard origin/master`
    on the main checkout (C:\dev\lantern-os) between turns; a server running there
    would have code and env yanked out from under it mid-request. Dedicated
    worktrees isolate the running servers from that churn.
    See docs/DEV-SERVER-WORKTREE.md.

    API keys and credentials are NOT stored in a committed .env — they live in the
    persistent Machine/User environment. This script hydrates that environment
    into both servers so they come up fully provisioned.

.PARAMETER NoChrome
    Skip auto-launching Chrome.

.PARAMETER StableRoot
    Worktree that serves :4177 (default C:\dev\lantern-os-stable).

.PARAMETER DevRoot
    Worktree that serves :4178 (default C:\dev\lantern-os-dev).

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1 -NoChrome
#>

param(
    [switch]$NoChrome,
    [string]$StableRoot = "C:\dev\lantern-os-stable",
    [string]$DevRoot    = "C:\dev\lantern-os-dev"
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot | Resolve-Path
$LogDir   = Join-Path $RepoRoot "logs"

Write-Host ""
Write-Host "Lantern OS - Dual Boot Quickstart (worktree-based)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# --- Prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Missing: Node.js" -ForegroundColor Red; exit 1 }
foreach ($wt in @($StableRoot, $DevRoot)) {
    if (-not (Test-Path (Join-Path $wt "apps\lantern-garage\server.js"))) {
        Write-Host "Worktree not found or incomplete: $wt" -ForegroundColor Red
        Write-Host "Create the dual-boot worktrees first (see docs/DEV-SERVER-WORKTREE.md):" -ForegroundColor Yellow
        Write-Host "  git worktree add $StableRoot stable-server" -ForegroundColor Gray
        Write-Host "  git worktree add $DevRoot dev-server" -ForegroundColor Gray
        exit 1
    }
}
Write-Host ("Node {0}; worktrees present." -f (node --version)) -ForegroundColor Green

# --- Hydrate persistent environment (so the servers get their keys) ----------
# Keys/credentials live in the Machine/User environment, not a committed .env.
foreach ($scope in 'Machine','User') {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($k in $vars.Keys) { try { Set-Item -Path ("env:" + $k) -Value $vars[$k] -ErrorAction SilentlyContinue } catch {} }
}

# --- Stop any existing web servers + their child services (keep cloudflared) --
Write-Host "Stopping existing :4177/:4178 servers and child services..." -ForegroundColor Yellow
foreach ($port in 4177,4178,8771,8772,5050) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Milliseconds 1000
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# --- :4177 stable / public (PORT=4177 -> binds 0.0.0.0 for the Cloudflare tunnel)
Write-Host "Starting stable :4177 from $StableRoot ..." -ForegroundColor Blue
$env:PORT = "4177"
$stable = Start-Process -FilePath "node" -ArgumentList "apps/lantern-garage/server.js" `
    -WorkingDirectory $StableRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "stable-4177.out.log") `
    -RedirectStandardError  (Join-Path $LogDir "stable-4177.err.log")

# --- :4178 dev / local (server-dev.js forces port 4178 and binds 127.0.0.1) --
Write-Host "Starting dev :4178 from $DevRoot ..." -ForegroundColor Green
Remove-Item env:PORT -ErrorAction SilentlyContinue   # server-dev.js sets its own port/host
$dev = Start-Process -FilePath "node" -ArgumentList "apps/lantern-garage/server-dev.js" `
    -WorkingDirectory $DevRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "dev-4178.out.log") `
    -RedirectStandardError  (Join-Path $LogDir "dev-4178.err.log")

# --- Health check ------------------------------------------------------------
Write-Host "Health check..." -ForegroundColor Yellow
$stableOk = $false; $devOk = $false
foreach ($i in 1..20) {
    if (-not $stableOk) { try { if ((Invoke-WebRequest "http://127.0.0.1:4177/api/version" -TimeoutSec 2 -ErrorAction SilentlyContinue).StatusCode -eq 200) { $stableOk = $true } } catch {} }
    if (-not $devOk)    { try { if ((Invoke-WebRequest "http://127.0.0.1:4178/api/version" -TimeoutSec 2 -ErrorAction SilentlyContinue).StatusCode -eq 200) { $devOk = $true } } catch {} }
    if ($stableOk -and $devOk) { break }
    Start-Sleep -Milliseconds 800
}
if ($stableOk) { Write-Host "  OK  stable :4177 (pid $($stable.Id))" -ForegroundColor Green } else { Write-Host "  WARN stable :4177 not responding - see $LogDir\stable-4177.err.log" -ForegroundColor Yellow }
if ($devOk)    { Write-Host "  OK  dev    :4178 (pid $($dev.Id))"    -ForegroundColor Green } else { Write-Host "  WARN dev :4178 not responding - see $LogDir\dev-4178.err.log" -ForegroundColor Yellow }

if (-not $NoChrome) {
    try { Start-Process "chrome.exe" "http://127.0.0.1:4177/dream-chat.html" -ErrorAction SilentlyContinue } catch {}
}

Write-Host ""
Write-Host "Dual boot running:" -ForegroundColor Cyan
Write-Host "  Stable (public) http://127.0.0.1:4177  <- $StableRoot" -ForegroundColor Blue
Write-Host "  Dev    (local)  http://127.0.0.1:4178  <- $DevRoot" -ForegroundColor Green
Write-Host ""
Write-Host "Note: both instances run their own Discord bot / Kalshi collector and try to" -ForegroundColor DarkGray
Write-Host "bind the shared MCP port 8771 - only one wins; the other logs a bind error and" -ForegroundColor DarkGray
Write-Host "keeps serving HTTP. The Cloudflare tunnel (if running) reconnects to :4177." -ForegroundColor DarkGray
Write-Host ""
# Servers run detached (Start-Process); this launcher returns instead of blocking.
