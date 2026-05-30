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
$held = [System.Collections.Generic.List[object]]::new()

$required = @(
    "README.md",
    "AGENTS.md",
    "docs/CONVERGENCE-LOOP.md",
    "docs/INNOVATOR-EVIDENCE-METHOD.md",
    "docs/V1-READINESS-GATES.md",
    "docs/LANTERN-OS-RECEPTIONIST-CALL-LIST.md",
    "manifests/comet-leap-30day-artifacts.md",
    "manifests/windows-surfaces.md",
    "manifests/dual-boot.md",
    "manifests/open-issues.md",
    "manifests/retired-surfaces.md",
    "manifests/CONVERGENCE-LOOP-AGENT-FLEET.md",
    "manifests/MCP-WORK-SPLIT.md",
    "manifests/validation/CONVERGENCE-FLEET-LATEST.json",
    "scripts/Test-ConvergenceAgentFleet.py",
    "skills/asi-arc-reactor-mk1/SKILL.md",
    "manifests/evidence/asi-local-pdf-convergence-2026-05-29.md",
    ".windsurf/hooks.json"
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

$fleetDoc = Join-Path $Root "manifests/CONVERGENCE-LOOP-AGENT-FLEET.md"
if (Test-Path $fleetDoc) {
    $fleetText = Get-Content -LiteralPath $fleetDoc -Raw
    foreach ($phrase in @("12 convergence-loop steps x 3 agents per step = 36 ring agents", "Always-Waiting Ring Contract", "poolTarget = 64", "design_contract_not_live_worker_proof")) {
        if ($fleetText -notlike "*$phrase*") {
            Add-Issue $issues "FLEET-MISSING-$($phrase.Replace(' ', '-'))" "high" "Convergence fleet contract missing phrase: $phrase" "Update manifests/CONVERGENCE-LOOP-AGENT-FLEET.md."
        }
    }
}

$mcpSplitDoc = Join-Path $Root "manifests/MCP-WORK-SPLIT.md"
if (Test-Path $mcpSplitDoc) {
    $mcpSplitText = Get-Content -LiteralPath $mcpSplitDoc -Raw
    foreach ($phrase in @("Split Lanes", "Private Dependency Boundary", "OS Review Gate", "No Bulk Remote Push Without Gate")) {
        if ($mcpSplitText -notlike "*$phrase*") {
            Add-Issue $issues "MCP-SPLIT-MISSING-$($phrase.Replace(' ', '-'))" "high" "MCP work split missing phrase: $phrase" "Update manifests/MCP-WORK-SPLIT.md."
        }
    }
}

$callListDoc = Join-Path $Root "docs/LANTERN-OS-RECEPTIONIST-CALL-LIST.md"
if (Test-Path $callListDoc) {
    $callListText = Get-Content -LiteralPath $callListDoc -Raw
    foreach ($phrase in @("organization switchboards", "Do not add personal phone numbers", "Call Receipt", "Evidence class: operator_call_receipt")) {
        if ($callListText -notlike "*$phrase*") {
            Add-Issue $issues "CALL-LIST-MISSING-$($phrase.Replace(' ', '-'))" "medium" "Receptionist call list missing phrase: $phrase" "Update docs/LANTERN-OS-RECEPTIONIST-CALL-LIST.md."
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

# ASI Arc Reactor MK1 validation
$asiSkillDoc = Join-Path $Root "skills/asi-arc-reactor-mk1/SKILL.md"
if (Test-Path $asiSkillDoc) {
    $asiText = Get-Content -LiteralPath $asiSkillDoc -Raw
    $requiredAsiPhrases = @(
        "ASI patterns are architecture references only",
        "no local ASI capability claim",
        "no investment advice",
        "Brier-style error tracking",
        "human trial readiness"
    )
    foreach ($phrase in $requiredAsiPhrases) {
        if ($asiText -notlike "*$phrase*") {
            Add-Issue $issues "ASI-MISSING-$phrase" "high" "ASI skill missing required phrase: $phrase" "Add phrase to skills/asi-arc-reactor-mk1/SKILL.md."
        }
    }
}

$asiEvidenceDoc = Join-Path $Root "manifests/evidence/asi-local-pdf-convergence-2026-05-29.md"
if (Test-Path $asiEvidenceDoc) {
    $asiEvidenceText = Get-Content -LiteralPath $asiEvidenceDoc -Raw
    $blockedClaims = @(
        "ASI capability exists locally",
        "token issuance or investment advice",
        "agent networks can bypass human approval"
    )
    foreach ($claim in $blockedClaims) {
        if ($asiEvidenceText -notlike "*$claim*") {
            Add-Issue $issues "ASI-EVIDENCE-MISSING-BLOCK-$claim" "high" "ASI evidence missing blocked claim: $claim" "Add blocked claim to manifests/evidence/asi-local-pdf-convergence-2026-05-29.md."
        }
    }
}

# Windsurf hooks validation
$hooksConfig = Join-Path $Root ".windsurf/hooks.json"
if (Test-Path $hooksConfig) {
    $hooksText = Get-Content -LiteralPath $hooksConfig -Raw
    $requiredHooks = @(
        "pre_run_command",
        "pre_mcp_tool_use",
        "pre_write_code"
    )
    foreach ($hook in $requiredHooks) {
        if ($hooksText -notlike "*$hook*") {
            Add-Issue $issues "HOOKS-MISSING-$hook" "medium" "Windsurf hooks missing: $hook" "Add $hook to .windsurf/hooks.json."
        }
    }
}

$sourceRepos = @(
    "C:\tmp\human-flourishing-frameworks-scan",
    "C:\Users\alexp\Documents\gm-agent-orchestrator"
)

$sourceStates = foreach ($repo in $sourceRepos) {
    if (Test-Path -LiteralPath $repo) {
        $status = @()
        $gitStatusError = $null
        $gitStatusMode = "normal"
        try {
            $status = @(git -C $repo status --short 2>&1)
            if ($LASTEXITCODE -ne 0) {
                $gitStatusError = ($status -join " ")
                $status = @()
            }
        } catch {
            $gitStatusError = $_.Exception.Message
            $status = @()
        }

        if ($gitStatusError -and $gitStatusError -like "*dubious ownership*") {
            try {
                $retryStatus = @(git -c "safe.directory=$repo" -c "core.excludesFile=" -C $repo status --short 2>&1)
                if ($LASTEXITCODE -eq 0) {
                    $status = $retryStatus
                    $gitStatusError = $null
                    $gitStatusMode = "safe_directory_read_only_retry"
                }
                else {
                    $gitStatusError = ($retryStatus -join " ")
                }
            }
            catch {
                $gitStatusError = $_.Exception.Message
            }
        }

        if ($gitStatusError) {
            Add-Issue $issues "SOURCE-GIT-STATUS-FAILED-$($repo.Replace('\', '-').Replace(':', ''))" "high" "Git status failed for source repo: $repo" "Fix git safe-directory/ownership or inspect manually before source repo mutation."
        }

        [pscustomobject]@{
            repo = $repo
            exists = $true
            dirty = if ($gitStatusError) { $null } else { ($status.Count -gt 0) }
            changedCount = $status.Count
            state = if ($gitStatusError) { "git_status_failed" } elseif ($status.Count -gt 0) { "local_dirty" } else { "local_clean" }
            gitStatusError = $gitStatusError
            gitStatusMode = $gitStatusMode
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
    designedRingSlots = 36
    elasticPoolTarget = 64
    fleetClaimBoundary = "design contract only; live worker counts require local orchestrator evidence"
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
