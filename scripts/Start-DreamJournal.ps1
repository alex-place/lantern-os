#Requires -Version 5.1
<#
.SYNOPSIS
    Start the Dream Journal (Python) server for Lantern OS.

.DESCRIPTION
    Activates the local Python virtual environment and launches
    uvicorn for apps.lantern-garage.server:app on 127.0.0.1:4177.
    If the server is already running, opens the browser instead.

.PARAMETER Port
    Override the default port (4177).

.PARAMETER NoReload
    Disable auto-reload (useful for stable demos).

.EXAMPLE
    .\scripts\Start-DreamJournal.ps1

.EXAMPLE
    .\scripts\Start-DreamJournal.ps1 -Port 5177 -NoReload
#>
param(
    [int]$Port = 4177,
    [switch]$NoReload
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$appModule = "apps.lantern-garage.server:app"
$appUrl = "http://127.0.0.1:$Port"
$healthUrl = "$appUrl/api/health"

# Check if already running
function Test-ServerHealth {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true')
    } catch {
        return $false
    }
}

if (Test-ServerHealth) {
    Write-Host "Dream Journal is already running at $appUrl" -ForegroundColor Green
    Start-Process $appUrl
    return
}

# Validate venv
if (-not (Test-Path $venvPython)) {
    Write-Error "Python virtual environment not found at $venvPython`nRun the installer first: scripts\install-dream-journal.ps1"
    exit 1
}

# Validate module exists (rough check)
$serverPy = Join-Path $root "server.py"
if (-not (Test-Path $serverPy)) {
    Write-Warning "Could not find $serverPy — server may fail to start if the module name has changed."
}

# Build uvicorn args
$reloadArg = if ($NoReload) { @() } else { @("--reload") }
$uvicornArgs = @("-m", "uvicorn", $appModule, "--host", "127.0.0.1", "--port", "$Port") + $reloadArg

Write-Host "Starting Dream Journal..." -ForegroundColor Cyan
Write-Host "  URL    : $appUrl" -ForegroundColor Gray
Write-Host "  Venv   : $venvPython" -ForegroundColor Gray
Write-Host "  Reload : $(if ($NoReload) { 'OFF' } else { 'ON' })" -ForegroundColor Gray
Write-Host ""

Set-Location -LiteralPath $root
& $venvPython @uvicornArgs
