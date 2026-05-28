param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [int]$FixWindow = 4,
    [switch]$CloudVirtualization
)

$ErrorActionPreference = "Stop"

function Add-Issue {
    param(
        [System.Collections.Generic.List[object]]$Issues,
        [string]$Id,
        [string]$Severity,
        [string]$Summary,
        [string]$Fix
    )

    $Issues.Add([pscustomobject]@{
        id = $Id
        severity = $Severity
        summary = $Summary
        fix = $Fix
    }) | Out-Null
}

function Test-PathRelative {
    param([string]$RelativePath)
    return Test-Path -LiteralPath (Join-Path $Root $RelativePath)
}

$issues = [System.Collections.Generic.List[object]]::new()
$fixed = [System.Collections.Generic.List[object]]::new()
$held = [System.Collections.Generic.List[object]]::new()

$required = @(
    "README.md",
    "AGENTS.md",
    "docs/CONVERGENCE-LOOP.md",
    "docs/INNOVATOR-EVIDENCE-METHOD.md",
    "docs/V1-READINESS-GATES.md",
    "manifests/comet-leap-30day-artifacts.md",
    "manifests/windows-surfaces.md",
    "manifests/dual-boot.md",
    "manifests/open-issues.md",
    "manifests/retired-surfaces.md"
)

foreach ($path in $required) {
    if (-not (Test-PathRelative $path)) {
        Add-Issue $issues "MISSING-$path" "high" "Missing required repo surface: $path" "Create $path before expansion."
    }
}

$loopDoc = Join-Path $Root "docs/CONVERGENCE-LOOP.md"
if (Test-Path $loopDoc) {
    $loopText = Get-Content -LiteralPath $loopDoc -Raw
    foreach ($phrase in @("Retire old stuff", "fix the first 2-4", "12 Steps", "Promote, hold, or reject")) {
        if ($loopText -notlike "*$phrase*") {
            Add-Issue $issues "LOOP-MISSING-$($phrase.Replace(' ', '-'))" "medium" "Convergence loop missing phrase: $phrase" "Update docs/CONVERGENCE-LOOP.md."
        }
    }
}

$innovatorDoc = Join-Path $Root "docs/INNOVATOR-EVIDENCE-METHOD.md"
if (Test-Path $innovatorDoc) {
    $innovatorText = Get-Content -LiteralPath $innovatorDoc -Raw
    if ($innovatorText -notlike "*Seven smoke check is deprecated*") {
        Add-Issue $issues "LEGACY-SEVEN-NOT-RETIRED" "high" "Legacy Seven path is not clearly deprecated." "Mark Seven as deprecated and point to the convergence loop."
    }
}

$readinessDoc = Join-Path $Root "docs/V1-READINESS-GATES.md"
if (Test-Path $readinessDoc) {
    $readinessText = Get-Content -LiteralPath $readinessDoc -Raw
    foreach ($gate in @("Gate 7", "Gate 8", "Gate 9")) {
        if ($readinessText -notlike "*$gate*") {
            Add-Issue $issues "READINESS-MISSING-$gate" "medium" "Readiness gates missing $gate." "Add $gate to docs/V1-READINESS-GATES.md."
        }
    }
}

$sourceRepos = @(
    "C:\tmp\human-flourishing-frameworks-scan",
    "C:\Users\alexp\Documents\gm-agent-orchestrator"
)

$sourceStates = foreach ($repo in $sourceRepos) {
    if (Test-Path -LiteralPath $repo) {
        $status = @(git -C $repo status --short 2>$null)
        [pscustomobject]@{
            repo = $repo
            exists = $true
            dirty = ($status.Count -gt 0)
            changedCount = $status.Count
            state = if ($status.Count -gt 0) { "local_dirty" } else { "local_clean" }
        }
    } else {
        if (-not $CloudVirtualization) {
            Add-Issue $issues "SOURCE-MISSING-$repo" "medium" "Source repo missing: $repo" "Update manifests to current source paths."
        }
        [pscustomobject]@{
            repo = $repo
            exists = $false
            dirty = $false
            changedCount = 0
            state = if ($CloudVirtualization) { "cloud_metadata_only" } else { "missing" }
            boundary = if ($CloudVirtualization) { "Local source tree is not visible from GitHub Actions; inspect locally before mutation." } else { "Local source tree expected but missing." }
        }
    }
}

$dualBootIssue = [pscustomobject]@{
    id = "LANTERN-OS-BOOT-001"
    severity = "blocked"
    summary = "Actual dual boot installation requires physical operator action."
    fix = "Keep held; do not automate disk, BCD, firmware, or bootloader mutation."
}
$held.Add($dualBootIssue) | Out-Null

if ($CloudVirtualization) {
    $held.Add([pscustomobject]@{
        id = "LANTERN-OS-CLOUD-LOCAL-001"
        severity = "held"
        summary = "Cloud virtualization cannot see local-only MCP endpoints, dirty worktrees, Windows Store apps, or private disks."
        fix = "Validate repo invariants in cloud; validate local runtime through Start-LanternLocalControls.ps1 on the operator machine."
    }) | Out-Null
}

$result = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    root = $Root
    mode = if ($CloudVirtualization) { "cloud_virtualization" } else { "local" }
    method = "Lantern OS 12-step convergence loop"
    fixWindow = $FixWindow
    issueCount = $issues.Count
    leadingIssues = @($issues | Select-Object -First $FixWindow)
    held = $held
    sourceRepos = $sourceStates
    nextAction = if ($issues.Count -gt 0) {
        "Fix the first $([Math]::Min($FixWindow, $issues.Count)) actionable issue(s), then rerun."
    } elseif ($CloudVirtualization) {
        "Cloud repo invariants passed. Run local controls on the operator machine before MCP/local runtime mutation."
    } else {
        "No local loop issues found. Review held issues and choose the next promotion candidate."
    }
}

$json = $result | ConvertTo-Json -Depth 8
Write-Output $json

if ($issues.Count -gt 0) {
    exit 1
}

exit 0
