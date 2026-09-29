#requires -Version 5.1
<#
.SYNOPSIS
    Start a Lantern OS Convergence session — server, health checks, and surface verification.
.DESCRIPTION
    Kills stale node processes, starts the lantern-garage dev server,
    waits for health, verifies all key surfaces, and saves the PID.
    Run at the beginning of every convergence workstream.
.EXAMPLE
    .\scripts\Start-ConvergenceSession.ps1
    .\scripts\Start-ConvergenceSession.ps1 -Port 4177 -Verbose
#>
[CmdletBinding()]
param(
    [int]$Port = 4177,
    [switch]$SkipKill,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repoRoot ".convergence-server.pid"
$logFile = Join-Path $repoRoot ".convergence-server.log"

function Test-ServerHealth {
    param([string]$Url = "http://127.0.0.1:$Port/api/health")
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Get-ServerPid {
    if (Test-Path $pidFile) {
        $saved = Get-Content $pidFile -Raw
        if ($saved -match '^\d+$') {
            try { return [int]$saved } catch { return 0 }
        }
    }
    return 0
}

function Invoke-SurfaceVerification {
    Write-Host "[VERIFY] Checking surfaces..." -ForegroundColor Cyan
    $surfaces = @(
        @{ Path = "/";               Name = "Landing"    },
        @{ Path = "/dream-chat.html";  Name = "Journal"    },
        @{ Path = "/flourishing";       Name = "Dashboard"  },
        @{ Path = "/rag-house.html";    Name = "RAG House"  },
        @{ Path = "/changelog.html";    Name = "Changelog"  },
        @{ Path = "/three-doors-game.html"; Name = "Explore" },
        @{ Path = "/agent-status.html"; Name = "System"     }
    )

    $allOk = $true
    foreach ($s in $surfaces) {
        $url = "http://127.0.0.1:$Port$($s.Path)"
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            $status = if ($r.StatusCode -eq 200) { "OK" } else { "HTTP $($r.StatusCode)" }
            $color = if ($r.StatusCode -eq 200) { "Green" } else { "Yellow" }
            Write-Host "  [$status] $($s.Name)" -ForegroundColor $color
        } catch {
            Write-Host "  [FAIL] $($s.Name)" -ForegroundColor Red
            $allOk = $false
        }
    }

    if ($allOk) {
        Write-Host "[OK] All surfaces verified" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Some surfaces failed verification" -ForegroundColor Yellow
    }
}

Write-Host "=== Lantern OS Convergence Session ===" -ForegroundColor Cyan
Write-Host "Port: $Port"
Write-Host "Repo: $repoRoot"

# ── Check if already healthy ──
if (Test-ServerHealth) {
    Write-Host "[OK] Server already running and healthy on port $Port" -ForegroundColor Green
    if (-not $SkipVerify) {
        Invoke-SurfaceVerification
    }
    return
}

# ── Kill stale node processes ──
if (-not $SkipKill) {
    Write-Host "[CLEAN] Stopping stale node processes..." -ForegroundColor Yellow
    $stale = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match "server\.js" -or $_.CommandLine -match "lantern-garage"
    }
    if ($stale) {
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "[CLEAN] Killed $($stale.Count) stale process(es)" -ForegroundColor Yellow
    }
    Start-Sleep -Milliseconds 500
}

# ── Start server ──
Write-Host "[START] Starting lantern-garage server..." -ForegroundColor Cyan
$proc = Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory (Join-Path $repoRoot "apps" "lantern-garage") `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError (Join-Path $repoRoot ".convergence-server.err") `
    -WindowStyle Hidden `
    -PassThru

$proc.Id | Set-Content $pidFile
Write-Host "[START] Server PID: $($proc.Id)" -ForegroundColor Cyan

# ── Wait for health ──
Write-Host "[WAIT] Waiting for server health..." -NoNewline
$maxWait = 30
$started = $false
for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    if (Test-ServerHealth) {
        $started = $true
        break
    }
    Write-Host "." -NoNewline
}
Write-Host ""

if (-not $started) {
    Write-Host "[FAIL] Server did not become healthy within ${maxWait}s" -ForegroundColor Red
    Write-Host "[LOG] $($logFile)" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Server healthy on port $Port" -ForegroundColor Green

# ── Verify surfaces ──
if (-not $SkipVerify) {
    Invoke-SurfaceVerification
}

Write-Host "=== Convergence session ready ===" -ForegroundColor Cyan
Write-Host "PID file: $pidFile"
Write-Host "Log file: $logFile"
Write-Host "Stop server: Stop-Process -Id $(Get-ServerPid)"
