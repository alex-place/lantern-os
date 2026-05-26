# ============================================================================
# LANTERN OS - IMMEDIATE EXECUTION WRAPPER
# ============================================================================
# This script is a direct execution wrapper for the orchestration pipeline
# Run directly: powershell -NoProfile -ExecutionPolicy Bypass -File EXECUTE-ORCHESTRATION.ps1

param(
    [switch]$SkipConsolidation = $false,
    [switch]$SkipValidation = $false,
    [switch]$SkipDeploy = $false
)

# Verify we're in the lantern-os directory
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path "$ScriptRoot\lantern-os-master-orchestration.ps1")) {
    Write-Host "ERROR: lantern-os-master-orchestration.ps1 not found in $ScriptRoot" -ForegroundColor Red
    Write-Host "Current directory: $(Get-Location)"
    exit 1
}

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "LANTERN OS - ORCHESTRATION EXECUTION WRAPPER" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Directory: $ScriptRoot" -ForegroundColor Green
Write-Host "Executing master orchestration script..."
Write-Host ""

# Execute the master orchestration script with all parameters
& "$ScriptRoot\lantern-os-master-orchestration.ps1" `
    -SkipConsolidation:$SkipConsolidation `
    -SkipValidation:$SkipValidation `
    -SkipDeploy:$SkipDeploy

# Capture exit code
$ExitCode = $LASTEXITCODE

# Report completion
Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
if ($ExitCode -eq 0) {
    Write-Host "ORCHESTRATION COMPLETED SUCCESSFULLY" -ForegroundColor Green
    Write-Host "Task #23: Complete incubator consolidation and push to master - DONE" -ForegroundColor Green
} else {
    Write-Host "ORCHESTRATION COMPLETED WITH EXIT CODE: $ExitCode" -ForegroundColor Yellow
}
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

exit $ExitCode
