# Start-SuperJarvisFleet.ps1
# Lantern OS Super-Jarvis MCP Superfleet 36 Slot Activation

param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [ValidateSet("sleep","low","wake")]
    [string]$Mode = "sleep",
    [switch]$ListSlots,
    [switch]$Verify
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Super-Jarvis MCP Superfleet - 36 Slot Manager" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$fleetPath = Join-Path $Root "data\status\super-jarvis-fleet.json"
$agentsPath = Join-Path $Root "config\agents.json"

if (-not (Test-Path $agentsPath)) {
    Write-Host "FATAL: Agent config not found: $agentsPath" -ForegroundColor Red
    exit 1
}

$agents = Get-Content $agentsPath -Raw | ConvertFrom-Json
Write-Host "OK: Agent config loaded: $($agents.slots.Count) slots defined" -ForegroundColor Green
Write-Host "OK: Designed ring slots: $($agents.designedRingSlots)" -ForegroundColor Green
Write-Host "OK: Elastic pool target: $($agents.elasticPoolTarget)" -ForegroundColor Green
Write-Host "    Fleet claim boundary: $($agents.fleetClaimBoundary)" -ForegroundColor Gray
Write-Host ""

if ($ListSlots) {
    Write-Host "--- Slot Registry ---" -ForegroundColor Yellow
    foreach ($slot in $agents.slots) {
        $color = if ($slot.mode -eq "sleep") { "Gray" } elseif ($slot.mode -eq "wake") { "Green" } else { "Yellow" }
        Write-Host "  $($slot.name) [$($slot.mode)]  step=$($slot.step)  role=$($slot.role)" -ForegroundColor $color
    }
    Write-Host ""
    Write-Host "Total: $($agents.slots.Count) slots" -ForegroundColor Cyan
    exit 0
}

$now = (Get-Date).ToUniversalTime().ToString("o")
$activeCount = 0
$sleepCount = 0

foreach ($slot in $agents.slots) {
    if ($Mode -eq "wake" -and $slot.name -match "-primary$") {
        $activeCount++
    } else {
        $sleepCount++
    }
}

$fleetStatus = [pscustomobject]@{
    generatedAt = $now
    fleetName = "Super-Jarvis MCP Superfleet"
    mode = $Mode
    designedRingSlots = 36
    elasticPoolTarget = 64
    fleetClaimBoundary = $agents.fleetClaimBoundary
    activeSlots = $activeCount
    sleepingSlots = $sleepCount
    slots = @($agents.slots | ForEach-Object {
        $state = if ($Mode -eq "wake" -and $_.name -match "-primary$") { "idle" } else { "sleep" }
        [pscustomobject]@{
            slot = $_.name
            role = $_.role
            state = $state
            step = $_.step
            worktree = (Split-Path $PSScriptRoot -Parent)
            branch = "master"
        }
    })
    mcpEndpoint = "http://127.0.0.1:8771"
    nextAction = if ($Mode -eq "sleep") {
        "All 36 ring slots registered in sleep mode. Wake individual slots via MCP dispatch_work or /dispatch Discord command."
    } elseif ($Mode -eq "low") {
        "36 slots in low-power mode. Primary agents idle; backups sleeping."
    } else {
        "Primary agents woken. Backups remain in sleep for failover."
    }
}

$fleetStatus | ConvertTo-Json -Depth 6 | Set-Content -Path $fleetPath -Encoding UTF8
Write-Host "OK: Fleet status written to: $fleetPath" -ForegroundColor Green

Write-Host "* Notifying MCP server..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8771/health" -Method GET -TimeoutSec 3
    Write-Host "OK: MCP server online: $($health.status)" -ForegroundColor Green
    Write-Host "OK: MCP slots reported: $($health.slots_online)" -ForegroundColor Green
} catch {
    Write-Host "NOTE: MCP server not reachable (expected if not running)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Super-Jarvis fleet mode: $Mode" -ForegroundColor Cyan
Write-Host "  Active slots: $activeCount" -ForegroundColor Cyan
Write-Host "  Sleeping slots: $sleepCount" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if ($Verify) {
    Write-Host "* Running convergence loop verification..." -ForegroundColor Yellow
    $convScript = Join-Path $Root "scripts\Invoke-LanternConvergenceLoop.ps1"
    if (Test-Path $convScript) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $convScript
        if ($LASTEXITCODE -eq 0) {
            Write-Host "OK: Convergence loop PASSED" -ForegroundColor Green
        } else {
            Write-Host "WARN: Convergence loop reported issues" -ForegroundColor Yellow
        }
    }
}
