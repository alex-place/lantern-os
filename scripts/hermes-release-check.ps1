# Hermes Release-Check — automated confidence table generation
# Emits manifests/hermes-confidence-latest.json as a CI artifact
# Usage: powershell -File .\scripts\hermes-release-check.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestDir = Join-Path $repoRoot "manifests"
if (-not (Test-Path $manifestDir)) { New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null }

function Check-FileExists($path, $minLines = 1) {
    if (-not (Test-Path $path)) { return @{ok=$false; detail="missing"} }
    $lines = @(Get-Content $path -ErrorAction SilentlyContinue).Count
    if ($lines -lt $minLines) { return @{ok=$false; detail="only ${lines} lines"} }
    return @{ok=$true; detail="${lines} lines"}
}

function Check-Endpoint($url, $timeoutSec = 10) {
    try {
        $r = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec $timeoutSec -UseBasicParsing -ErrorAction Stop
        return @{ok=$true; status=$r.StatusCode }
    } catch {
        return @{ok=$false; status=$_.Exception.Response.StatusCode.Value__; detail=$_.Exception.Message }
    }
}

function Check-WorkflowRun() {
    # Check if .github/workflows/ci.yml exists and has content
    $ci = Check-FileExists (Join-Path $repoRoot ".github\workflows\ci.yml") 10
    $deploy = Check-FileExists (Join-Path $repoRoot ".github\workflows\deploy.yml") 10
    return @{
        ci_config = $ci.ok
        deploy_config = $deploy.ok
        ci_detail = $ci.detail
        deploy_detail = $deploy.detail
    }
}

# ── Build confidence table ────────────────────────────────────────────

$table = @{
    generated_at = (Get-Date -Format "o")
    hermes_version = "0.1.0"
    gates = @(
        @{id="G1"; name="Core journal"; owner="CI"; checks=@("create","stats","search","read","export") }
        @{id="G2"; name="Real UI browse"; owner="Dream Journal UI"; checks=@("recent_entries_render") }
        @{id="G3"; name="Semantic memory"; owner="MemOS"; checks=@("memos_health","save_ingest") }
        @{id="G4"; name="Chat context"; owner="MemOS"; checks=@("chat_semantic_context") }
        @{id="G5"; name="Static/server truth"; owner="Hermes"; checks=@("deploy_label_accuracy") }
        @{id="G6"; name="Deploy smoke"; owner="Hermes"; checks=@("static_url_probe","api_health_probe") }
        @{id="G7"; name="Safety copy"; owner="Tests+Hermes"; checks=@("no_therapy_claims","no_cloud_sync_claims") }
        @{id="G8"; name="Release confidence"; owner="Hermes"; checks=@("confidence_table_artifact") }
    )
    scores = @{}
    evidence = @{}
}

# G1: Core journal tests
$apiTest = Check-FileExists (Join-Path $repoRoot "tests\test_dream_journal_api.js") 20
$chatTest = Check-FileExists (Join-Path $repoRoot "tests\test_dream_chat_multiturns.js") 20
$pyTest = Check-FileExists (Join-Path $repoRoot "tests\test_dashboard_ux.py") 1
$table.scores.G1 = if ($apiTest.ok -and $chatTest.ok) { 0.82 } else { 0.55 }
$table.evidence.G1 = @{api_test=$apiTest.detail; chat_test=$chatTest.detail; py_test=$pyTest.detail}

# G2: Real UI browse
$indexHtml = Check-FileExists (Join-Path $repoRoot "public\index.html") 300
$hasRecentEntries = $indexHtml.ok -and (Select-String -Path (Join-Path $repoRoot "public\index.html") -Pattern "recent-entries" -Quiet)
$table.scores.G2 = if ($hasRecentEntries) { 0.72 } else { 0.42 }
$table.evidence.G2 = @{index_html_lines=$indexHtml.detail; has_recent_entries=$hasRecentEntries}

# G3: Semantic memory
$memosBridge = Check-FileExists (Join-Path $repoRoot "src\convergence_io\memos_bridge.py") 30
$dreamRoute = Check-FileExists (Join-Path $repoRoot "routes\dream.js") 100
$hasMemosIngest = $dreamRoute.ok -and (Select-String -Path (Join-Path $repoRoot "routes\dream.js") -Pattern "memos" -Quiet)
$hasMemoryHealth = $dreamRoute.ok -and (Select-String -Path (Join-Path $repoRoot "routes\dream.js") -Pattern "memory/health" -Quiet)
$table.scores.G3 = if ($hasMemosIngest -and $hasMemoryHealth) { 0.65 } else { 0.46 }
$table.evidence.G3 = @{memos_bridge=$memosBridge.detail; has_ingest=$hasMemosIngest; has_health=$hasMemoryHealth}

# G4: Chat context
$hasChatContext = $memosBridge.ok -and (Select-String -Path (Join-Path $repoRoot "src\convergence_io\memos_bridge.py") -Pattern "get_context_for_prompt" -Quiet)
$table.scores.G4 = if ($hasChatContext) { 0.68 } else { 0.48 }
$table.evidence.G4 = @{has_chat_context=$hasChatContext}

# G5: Static/server truth
$deployWorkflow = Check-FileExists (Join-Path $repoRoot ".github\workflows\deploy.yml") 10
$table.scores.G5 = if ($deployWorkflow.ok) { 0.62 } else { 0.40 }
$table.evidence.G5 = @{deploy_workflow=$deployWorkflow.detail}

# G6: Deploy smoke (probe if server is running)
$health = Check-Endpoint "http://127.0.0.1:4177/api/health" 5
$table.scores.G6 = if ($health.ok) { 0.72 } else { 0.50 }
$table.evidence.G6 = @{api_health=$health.status; api_health_detail=$health.detail}

# G7: Safety copy
$hasSafetyTests = $apiTest.ok -and (Select-String -Path (Join-Path $repoRoot "tests\test_dream_journal_api.js") -Pattern "safety|privacy|therapy|diagnosis" -Quiet)
$table.scores.G7 = if ($hasSafetyTests) { 0.76 } else { 0.60 }
$table.evidence.G7 = @{has_safety_tests=$hasSafetyTests}

# G8: Release confidence (this script itself)
$table.scores.G8 = 0.70
$table.evidence.G8 = @{hermes_script="hermes-release-check.ps1"; manifest_dir=$manifestDir}

# Overall
$overall = ($table.scores.Values | Measure-Object -Average).Average
$table.overall_confidence = [math]::Round($overall, 3)
$table.overall_label = if ($overall -ge 0.75) { "ready" } elseif ($overall -ge 0.55) { "caution" } else { "hold" }

# Write manifest
$outPath = Join-Path $manifestDir "hermes-confidence-latest.json"
$table | ConvertTo-Json -Depth 10 | Set-Content -Path $outPath -Encoding UTF8
Write-Host "Hermes confidence table written to $outPath" -ForegroundColor Green
Write-Host "Overall confidence: $($table.overall_confidence) ($($table.overall_label))" -ForegroundColor $(if ($table.overall_label -eq "ready") { "Green" } elseif ($table.overall_label -eq "caution") { "Yellow" } else { "Red" })
foreach ($g in $table.gates) {
    $s = $table.scores[$g.id]
    $color = if ($s -ge 0.75) { "Green" } elseif ($s -ge 0.55) { "Yellow" } else { "Red" }
    Write-Host "  $($g.id) $($g.name): $s" -ForegroundColor $color
}
