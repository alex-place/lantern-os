<#
.SYNOPSIS
    Dream Journal v0 Release Validation Script
.DESCRIPTION
    Validates the Dream Journal v0 ship readiness by checking:
    - HTML pages exist and load
    - JavaScript files have no syntax errors
    - API endpoints respond correctly
    - JSONL storage directories exist
    - Test suites pass
    - Safety boundaries are present
#>

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$failures = 0

function Write-Check($label, $passed, $detail = "") {
    if ($passed) {
        Write-Host "  [PASS] $label" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $label $detail" -ForegroundColor Red
        $script:failures++
    }
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Dream Journal v0 Release Validation" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 1. HTML Pages
Write-Host "1. HTML Pages" -ForegroundColor Yellow
$pages = @(
    "public/index.html",
    "public/dream-chat.html",
    "public/outreach.html"
)
foreach ($page in $pages) {
    $path = Join-Path $repoRoot $page
    Write-Check $page (Test-Path $path)
}

# 2. JavaScript Syntax
Write-Host "`n2. JavaScript Syntax" -ForegroundColor Yellow
$jsFiles = @(
    "server.js",
    "public/app.js"
)
foreach ($js in $jsFiles) {
    $path = Join-Path $repoRoot $js
    if (Test-Path $path) {
        $result = node --check $path 2>&1
        Write-Check $js ($LASTEXITCODE -eq 0) $result
    } else {
        Write-Check $js $false "File not found"
    }
}

# 3. API Endpoints
Write-Host "`n3. API Endpoints" -ForegroundColor Yellow
$endpoints = @(
    @{Method="GET"; Path="/api/dream/stats"; Expect=200},
    @{Method="POST"; Path="/api/dream/chat"; Body='{"message":"release test"}'; Expect=200},
    @{Method="GET"; Path="/api/dream/search"; Expect=200}
)
foreach ($ep in $endpoints) {
    try {
        if ($ep.Method -eq "GET") {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:4177$($ep.Path)" -TimeoutSec 5
        } else {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:4177$($ep.Path)" -Method POST -Body $ep.Body -ContentType "application/json" -TimeoutSec 10
        }
        Write-Check "$($ep.Method) $($ep.Path)" $true
    } catch {
        Write-Check "$($ep.Method) $($ep.Path)" $false $_.Exception.Message
    }
}

# 4. JSONL Storage Directories
Write-Host "`n4. JSONL Storage Directories" -ForegroundColor Yellow
$dataDirs = @(
    "data/dreamers",
    "data/conversations"
)
foreach ($dir in $dataDirs) {
    $path = Join-Path $repoRoot $dir
    Write-Check $dir (Test-Path $path)
}

# 5. Test Files
Write-Host "`n5. Test Files" -ForegroundColor Yellow
$testFiles = @(
    "tests/test_dream_journal_api.js",
    "tests/test_dream_journal_chat.js",
    "tests/test_dreamer_journal.py",
    "tests/test_dreamer_integration.py",
    "tests/e2e/dreamer-journal.spec.ts",
    "tests/fixtures/dreamer-test-data.json"
)
foreach ($tf in $testFiles) {
    $path = Join-Path $repoRoot $tf
    Write-Check $tf (Test-Path $path)
}

# 6. Run Node.js Tests
Write-Host "`n6. Node.js API Tests" -ForegroundColor Yellow
$apiTest = node (Join-Path $repoRoot "tests/test_dream_journal_api.js") 2>&1
$apiPass = $LASTEXITCODE -eq 0
Write-Check "API tests" $apiPass

Write-Host "`n7. Node.js Chat Tests" -ForegroundColor Yellow
$chatTest = node (Join-Path $repoRoot "tests/test_dream_journal_chat.js") 2>&1
$chatPass = $LASTEXITCODE -eq 0
Write-Check "Chat tests" $chatPass

# 8. Run Python Tests
Write-Host "`n8. Python Unit Tests" -ForegroundColor Yellow
$pyUnit = python -m pytest (Join-Path $repoRoot "tests/test_dreamer_journal.py") -v 2>&1 | Select-Object -Last 3
$pyUnitPass = $pyUnit -match "passed"
Write-Check "Python unit tests" $pyUnitPass $pyUnit

Write-Host "`n9. Python Integration Tests" -ForegroundColor Yellow
$pyInt = python -m pytest (Join-Path $repoRoot "tests/test_dreamer_integration.py") -v 2>&1 | Select-Object -Last 3
$pyIntPass = $pyInt -match "passed"
Write-Check "Python integration tests" $pyIntPass $pyInt

# 10. Safety Boundaries
Write-Host "`n10. Safety Boundaries" -ForegroundColor Yellow
$indexHtml = Get-Content (Join-Path $repoRoot "public/index.html") -Raw
$noMedical = $indexHtml -notmatch "therapist|diagnosis|prescription|treatment"
Write-Check "No medical claims in UI" $noMedical
$privacy = $indexHtml -match "private|local|your device|saved locally"
Write-Check "Privacy messaging present" $privacy

# Summary
Write-Host "`n============================================" -ForegroundColor Cyan
if ($failures -eq 0) {
    Write-Host "  ALL CHECKS PASSED — Ready to ship v0" -ForegroundColor Green
} else {
    Write-Host "  $failures CHECK(S) FAILED — Blocked" -ForegroundColor Red
}
Write-Host "============================================" -ForegroundColor Cyan
exit $failures
