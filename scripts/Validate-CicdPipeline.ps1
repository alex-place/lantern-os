<#
.SYNOPSIS
    Validate that CI/CD pipeline is healthy and responding
.DESCRIPTION
    Batch job that validates the CI/CD pipeline. This allows batch jobs to verify
    that CI/CD is working correctly. Part of mutual validation loop.
.PARAMETER GitHubRepo
    GitHub repo in format "owner/repo"
#>

param(
    [string]$GitHubRepo = "alex-place/lantern-os"
)

$ErrorActionPreference = "Continue"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$results = @{
    passed = @()
    failed = @()
    warnings = @()
}

Write-Host "`n[$timestamp] === CI/CD Pipeline Validation ===" -ForegroundColor Cyan

# ============================================================================
# 1. Check CI workflow files exist
# ============================================================================
Write-Host "[1/4] Checking CI/CD workflow files..." -NoNewline
$ciWorkflow = ".github/workflows/ci.yml"
$deployWorkflow = ".github/workflows/deploy.yml"

if ((Test-Path $ciWorkflow) -and (Test-Path $deployWorkflow)) {
    Write-Host " ✓" -ForegroundColor Green
    $results.passed += "CI and Deploy workflows present"
} else {
    Write-Host " ✗" -ForegroundColor Red
    $results.failed += "Missing workflow files"
    $missingFiles = @()
    if (!(Test-Path $ciWorkflow)) { $missingFiles += $ciWorkflow }
    if (!(Test-Path $deployWorkflow)) { $missingFiles += $deployWorkflow }
    $results.failed += "Missing: $($missingFiles -join ', ')"
}

# ============================================================================
# 2. Validate workflow structure
# ============================================================================
Write-Host "[2/4] Validating workflow structure..." -NoNewline
try {
    $ciContent = Get-Content $ciWorkflow -Raw
    $deployContent = Get-Content $deployWorkflow -Raw

    $ciHasJobs = $ciContent -match "jobs:"
    $deployHasSteps = $deployContent -match "steps:"

    if ($ciHasJobs -and $deployHasSteps) {
        Write-Host " ✓" -ForegroundColor Green
        $results.passed += "Workflow structure valid"
    } else {
        Write-Host " ✗" -ForegroundColor Red
        $results.failed += "Workflow structure invalid"
    }
} catch {
    Write-Host " ✗" -ForegroundColor Red
    $results.failed += "Could not read workflow files: $_"
}

# ============================================================================
# 3. Check Dockerfile (required for Deploy workflow)
# ============================================================================
Write-Host "[3/4] Checking Docker deployment readiness..." -NoNewline
if (Test-Path "Dockerfile") {
    Write-Host " ✓" -ForegroundColor Green
    $results.passed += "Dockerfile present"
} else {
    Write-Host " ✗" -ForegroundColor Red
    $results.failed += "Dockerfile missing"
}

# ============================================================================
# 4. Check critical files exist (that CI validates)
# ============================================================================
Write-Host "[4/4] Checking critical repo files (CI validates these)..." -NoNewline
$criticalFiles = @(
    "README.md",
    "AGENTS.md",
    "docs/CONVERGENCE-LOOP.md"
)

$missingCritical = @()
foreach ($file in $criticalFiles) {
    if (!(Test-Path $file)) {
        $missingCritical += $file
    }
}

if ($missingCritical.Count -eq 0) {
    Write-Host " ✓" -ForegroundColor Green
    $results.passed += "All critical files present"
} else {
    Write-Host " ✗" -ForegroundColor Red
    $results.failed += "Critical files missing: $($missingCritical -join ', ')"
}

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n[$timestamp] === Summary ===" -ForegroundColor Cyan
Write-Host "Passed: $($results.passed.Count)" -ForegroundColor Green
Write-Host "Failed: $($results.failed.Count)" -ForegroundColor Red
Write-Host "Warnings: $($results.warnings.Count)" -ForegroundColor Yellow

Write-Host "`nResults:" -ForegroundColor Cyan
$results.passed | ForEach-Object { Write-Host "  ✓ $_" -ForegroundColor Green }
$results.failed | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
$results.warnings | ForEach-Object { Write-Host "  ! $_" -ForegroundColor Yellow }

$status = if ($results.failed.Count -eq 0) { "HEALTHY" } else { "DEGRADED" }
Write-Host "`nCI/CD Pipeline Status: $status`n" -ForegroundColor $(if ($status -eq "HEALTHY") { "Green" } else { "Yellow" })

exit $(if ($results.failed.Count -eq 0) { 0 } else { 1 })
