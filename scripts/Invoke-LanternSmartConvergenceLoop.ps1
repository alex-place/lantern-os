param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [ValidateSet("Local", "Cloud")]
    [string]$Profile = "Local",
    [ValidateSet("Light", "Standard", "Deep")]
    [string]$Depth = "Standard",
    [string]$OutputPath,
    [switch]$ApplySafeFixes,
    [switch]$SkipNetwork,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

function New-StepResult {
    param(
        [string]$Id,
        [string]$Status,
        [string]$Summary,
        [object]$Evidence = $null
    )

    [pscustomobject]@{
        id = $Id
        status = $Status
        summary = $Summary
        evidence = $Evidence
    }
}

function New-Issue {
    param(
        [string]$Id,
        [string]$Severity,
        [string]$Summary,
        [string]$NextAction
    )

    [pscustomobject]@{
        id = $Id
        severity = $Severity
        summary = $Summary
        nextAction = $NextAction
    }
}

function Invoke-CapturedCommand {
    param(
        [string]$Id,
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 60
    )

    $job = Start-Job -ScriptBlock {
        param($WorkingDirectory, $CommandPath, [string[]]$CommandArguments)

        Set-Location -LiteralPath $WorkingDirectory
        $output = & $CommandPath @CommandArguments 2>&1 | Out-String
        [pscustomobject]@{
            output = $output.Trim()
            exitCode = $LASTEXITCODE
        }
    } -ArgumentList $Root, $FilePath, $Arguments

    if (-not (Wait-Job -Job $job -Timeout $TimeoutSeconds)) {
        Stop-Job -Job $job -Force | Out-Null
        Remove-Job -Job $job -Force | Out-Null
        return [pscustomobject]@{
            id = $Id
            exitCode = 124
            output = "Timed out after $TimeoutSeconds seconds."
            timedOut = $true
        }
    }

    $result = Receive-Job -Job $job
    Remove-Job -Job $job -Force | Out-Null

    return [pscustomobject]@{
        id = $Id
        exitCode = [int]$result.exitCode
        output = [string]$result.output
        timedOut = $false
    }
}

function Get-PackageScriptNames {
    param([string]$PackagePath)

    if (-not (Test-Path -LiteralPath $PackagePath)) {
        return @()
    }

    try {
        $package = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
        if (-not $package.scripts) {
            return @()
        }
        return @($package.scripts.PSObject.Properties | Select-Object -ExpandProperty Name)
    } catch {
        return @()
    }
}

function Get-GitState {
    $status = @(git -C $Root status --porcelain=v1 -uall 2>&1)
    $branch = @(git -C $Root status --short --branch 2>&1)
    $divergence = @(git -C $Root rev-list --left-right --count HEAD...origin/master 2>&1)
    $locks = @()

    $gitDir = Join-Path $Root ".git"
    if (Test-Path -LiteralPath $gitDir) {
        $locks = @(Get-ChildItem -LiteralPath $gitDir -Recurse -Filter "*.lock" -ErrorAction SilentlyContinue | ForEach-Object {
            $_.FullName.Substring($Root.Length + 1)
        })
    }

    [pscustomobject]@{
        branch = ($branch -join "`n")
        changedCount = $status.Count
        changed = $status
        divergence = ($divergence -join " ").Trim()
        lockCount = $locks.Count
        locks = $locks
    }
}

function Get-ConfidenceTable {
    @(
        [pscustomobject]@{
            action = "Git dirt, lock, and branch-divergence scan"
            cadence = "Every local loop; every 30 minutes if automated"
            confidence = 0.98
            reason = "Cheap, local, and directly blocks unsafe pull, push, cleanup, and self-repair."
            source = "Local repo contract"
        },
        [pscustomobject]@{
            action = "Lantern consolidate read-only scan"
            cadence = "Hourly local; every CI scheduled run in Cloud mode"
            confidence = 0.94
            reason = "Runs the existing Lantern 12-step contract and reports first actionable issues without writing when Output is omitted."
            source = "scripts/Invoke-LanternConvergenceLoop.ps1"
        },
        [pscustomobject]@{
            action = "Fast code syntax and contract checks"
            cadence = "On every commit or PR; hourly local while actively changing code"
            confidence = 0.92
            reason = "Catches broken JavaScript/PowerShell/Python surfaces before deeper tests spend time."
            source = "Repo validation"
        },
        [pscustomobject]@{
            action = "Local HTTP health probe"
            cadence = "Every 15-30 minutes only when the local app is expected to be running"
            confidence = 0.88
            reason = "Verifies the actual exposed local route without starting services or trusting stale status files."
            source = "Local-first MCP rule"
        },
        [pscustomobject]@{
            action = "Cloud scheduled CI smart loop"
            cadence = "Every 6 hours plus manual dispatch"
            confidence = 0.86
            reason = "GitHub schedule supports recurring checks, but cloud cannot prove local MCP, dirty worktrees, or Windows runtime state."
            source = "GitHub Actions schedule docs"
        },
        [pscustomobject]@{
            action = "npm audit high-severity threshold"
            cadence = "Daily in local/network-enabled loop; on demand before release"
            confidence = 0.84
            reason = "npm audit can fail CI at a chosen severity while preserving the full report for review."
            source = "npm audit docs"
        },
        [pscustomobject]@{
            action = "Dependabot dependency and GitHub Actions update PRs"
            cadence = "Weekly, with manual acceleration during dependency catch-up"
            confidence = 0.82
            reason = "Dependabot is purpose-built for dependency update PRs; weekly keeps churn controlled."
            source = "GitHub Dependabot docs"
        },
        [pscustomobject]@{
            action = "OpenSSF Scorecard supply-chain posture"
            cadence = "Weekly or release-candidate only"
            confidence = 0.78
            reason = "Good external posture signal, but private-repo support and result visibility depend on security settings."
            source = "OpenSSF Scorecard Action"
        },
        [pscustomobject]@{
            action = "Self-repair with ApplySafeFixes"
            cadence = "Manual only after a clean git scan"
            confidence = 0.70
            reason = "Useful for small missing config/docs repairs, but any code-changing repair should remain operator-reviewed."
            source = "Safety boundary"
        }
    )
}

$steps = [System.Collections.Generic.List[object]]::new()
$issues = [System.Collections.Generic.List[object]]::new()
$patchPlan = [System.Collections.Generic.List[object]]::new()

$gitState = Get-GitState
$steps.Add((New-StepResult "git-state" "observed" "Captured branch, dirt, divergence, and lock state." $gitState)) | Out-Null

if ($gitState.changedCount -gt 0) {
    $issues.Add((New-Issue "GIT-DIRTY" "high" "Working tree has $($gitState.changedCount) changed path(s)." "Inspect or commit intentionally before any push, cleanup, or code-changing self-repair.")) | Out-Null
}

if ($gitState.lockCount -gt 0) {
    $issues.Add((New-Issue "GIT-LOCKS" "medium" "Git lock files are present." "Verify no Git process owns them before deleting stale locks.")) | Out-Null
}

if ($gitState.divergence -and $gitState.divergence -notmatch "^0\s+0$") {
    $issues.Add((New-Issue "GIT-DIVERGED" "high" "HEAD and origin/master are not at parity: $($gitState.divergence)." "Resolve branch divergence before automation mutates source.")) | Out-Null
}

$requiredSelfSurfaces = @(
    "scripts/Invoke-LanternSmartConvergenceLoop.ps1",
    "docs/SMART-CONVERGENCE-LOOP.md",
    ".github/workflows/smart-convergence-loop.yml",
    ".github/dependabot.yml"
)

foreach ($surface in $requiredSelfSurfaces) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $surface))) {
        $patchPlan.Add([pscustomobject]@{
            id = "SELF-UPGRADE-MISSING-$surface"
            action = "Create $surface"
            applyMode = "manual-or-ApplySafeFixes"
        }) | Out-Null
    }
}

$convergenceScript = Join-Path $Root "scripts\Invoke-LanternConvergenceLoop.ps1"
if (Test-Path -LiteralPath $convergenceScript) {
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $convergenceScript, "-Root", $Root)
    if ($Profile -eq "Cloud") {
        $args += "-CloudVirtualization"
    }
    $loopResult = Invoke-CapturedCommand "lantern-consolidate" "powershell" $args 90
    $status = if ($loopResult.exitCode -eq 0) { "passed" } else { "needs_review" }
    $steps.Add((New-StepResult "lantern-consolidate" $status "Ran Lantern consolidate read-only scan." @{
        exitCode = $loopResult.exitCode
        timedOut = $loopResult.timedOut
        outputPreview = $loopResult.output.Substring(0, [Math]::Min(1200, $loopResult.output.Length))
    })) | Out-Null
    if ($loopResult.exitCode -ne 0) {
        $issues.Add((New-Issue "LANTERN-CONSOLIDATE-ISSUES" "medium" "Lantern consolidate reported issues or timed out." "Review the loop output and fix the first 2-4 actionable items.")) | Out-Null
    }
} else {
    $issues.Add((New-Issue "LANTERN-CONSOLIDATE-MISSING" "high" "scripts/Invoke-LanternConvergenceLoop.ps1 is missing." "Restore the Lantern consolidate script before using this wrapper.")) | Out-Null
}

$packageScripts = Get-PackageScriptNames (Join-Path $Root "package.json")
if ($packageScripts -contains "check") {
    $checkResult = Invoke-CapturedCommand "npm-check" "npm" @("run", "check") 120
    $steps.Add((New-StepResult "npm-check" $(if ($checkResult.exitCode -eq 0) { "passed" } else { "failed" }) "Ran npm run check." @{
        exitCode = $checkResult.exitCode
        outputPreview = $checkResult.output.Substring(0, [Math]::Min(1000, $checkResult.output.Length))
    })) | Out-Null
    if ($checkResult.exitCode -ne 0) {
        $issues.Add((New-Issue "NPM-CHECK-FAILED" "high" "npm run check failed." "Fix the failing syntax or contract check before widening automation.")) | Out-Null
    }
} else {
    $steps.Add((New-StepResult "npm-check" "skipped" "Root package.json has no check script; falling back to direct syntax checks." $packageScripts)) | Out-Null
    foreach ($jsFile in @("server.js", "cloud-server.js", "tests/regression/cicd-gates.js", "scripts/convergence-manager.js")) {
        if (Test-Path -LiteralPath (Join-Path $Root $jsFile)) {
            $nodeResult = Invoke-CapturedCommand "node-check-$jsFile" "node" @("--check", $jsFile) 45
            $steps.Add((New-StepResult "node-check-$jsFile" $(if ($nodeResult.exitCode -eq 0) { "passed" } else { "failed" }) "Ran node --check $jsFile." @{
                exitCode = $nodeResult.exitCode
                outputPreview = $nodeResult.output.Substring(0, [Math]::Min(800, $nodeResult.output.Length))
            })) | Out-Null
            if ($nodeResult.exitCode -ne 0) {
                $issues.Add((New-Issue "NODE-CHECK-FAILED-$jsFile" "high" "node --check failed for $jsFile." "Fix syntax before running deeper validation.")) | Out-Null
            }
        }
    }
}

if (Test-Path -LiteralPath (Join-Path $Root "scripts\Test-ConvergenceAgentFleet.py")) {
    $fleetResult = Invoke-CapturedCommand "fleet-contract" "python" @("scripts/Test-ConvergenceAgentFleet.py") 60
    $steps.Add((New-StepResult "fleet-contract" $(if ($fleetResult.exitCode -eq 0) { "passed" } else { "failed" }) "Validated convergence fleet design contract." @{
        exitCode = $fleetResult.exitCode
        outputPreview = $fleetResult.output.Substring(0, [Math]::Min(1000, $fleetResult.output.Length))
    })) | Out-Null
    if ($fleetResult.exitCode -ne 0) {
        $issues.Add((New-Issue "FLEET-CONTRACT-FAILED" "medium" "Convergence fleet design contract check failed." "Repair the design contract before claiming live fleet readiness.")) | Out-Null
    }
}

if ($Profile -eq "Local") {
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:4177/api/health" -UseBasicParsing -TimeoutSec 3
        $steps.Add((New-StepResult "local-health" "passed" "Local Lantern Garage health endpoint responded." @{
            statusCode = $health.StatusCode
            bodyPreview = $health.Content.Substring(0, [Math]::Min(500, $health.Content.Length))
        })) | Out-Null
    } catch {
        $steps.Add((New-StepResult "local-health" "held" "Local health endpoint did not respond; service was not started by this loop." $_.Exception.Message)) | Out-Null
    }
} else {
    $steps.Add((New-StepResult "local-health" "held" "Cloud profile cannot prove local Lantern Garage or MCP runtime state." $null)) | Out-Null
}

if (-not $SkipNetwork -and $Depth -ne "Light") {
    $auditResult = Invoke-CapturedCommand "npm-audit" "npm" @("audit", "--audit-level=high", "--omit=dev") 120
    $steps.Add((New-StepResult "npm-audit" $(if ($auditResult.exitCode -eq 0) { "passed" } else { "needs_review" }) "Ran npm audit with high severity threshold." @{
        exitCode = $auditResult.exitCode
        outputPreview = $auditResult.output.Substring(0, [Math]::Min(1000, $auditResult.output.Length))
    })) | Out-Null
    if ($auditResult.exitCode -ne 0) {
        $issues.Add((New-Issue "NPM-AUDIT-HIGH" "medium" "npm audit reported high-threshold findings or could not complete." "Review audit output; avoid npm audit fix without a focused dependency plan.")) | Out-Null
    }
} else {
    $steps.Add((New-StepResult "npm-audit" "skipped" "Network audit skipped by profile, depth, or SkipNetwork." $null)) | Out-Null
}

if ($ApplySafeFixes) {
    if ($gitState.changedCount -gt 0) {
        $issues.Add((New-Issue "SAFE-FIXES-HELD-DIRTY" "high" "ApplySafeFixes was requested but working tree is dirty." "Run self-repair only after a clean git scan.")) | Out-Null
    } else {
        $validationDir = Join-Path $Root "manifests\validation"
        if (-not (Test-Path -LiteralPath $validationDir)) {
            New-Item -ItemType Directory -Path $validationDir -Force | Out-Null
            $steps.Add((New-StepResult "safe-fix-validation-dir" "fixed" "Created manifests/validation directory." $validationDir)) | Out-Null
        }
    }
}

$issueArray = @($issues.ToArray())
$status = "pass"
if ((@($issueArray | Where-Object { $_.severity -eq "high" })).Count -gt 0) {
    $status = "blocked"
} elseif ($issueArray.Count -gt 0) {
    $status = "needs_review"
}

$report = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    root = $Root
    profile = $Profile
    depth = $Depth
    mode = if ($ApplySafeFixes) { "safe-fix-requested" } else { "observe-and-recommend" }
    status = $status
    issueCount = $issueArray.Count
    issues = $issueArray
    steps = $steps
    patchPlan = $patchPlan
    confidenceTable = Get-ConfidenceTable
    nextAction = if ($status -eq "pass") {
        "Loop checks passed. Review held local runtime boundaries before claiming live MCP or agent readiness."
    } elseif ($gitState.changedCount -gt 0) {
        "Inspect dirty paths first; do not self-repair, push, or cleanup until those changes are classified."
    } else {
        "Fix the first 2-4 actionable issues, then rerun this loop."
    }
}

$jsonText = $report | ConvertTo-Json -Depth 8

if ($OutputPath) {
    $resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $Root $OutputPath }
    $outputDirectory = Split-Path -Path $resolvedOutput -Parent
    if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    }
    $jsonText | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
}

if ($Json) {
    Write-Output $jsonText
} else {
    Write-Output "Lantern Smart Convergence Loop: $status"
    Write-Output "Issues: $($issues.Count)"
    foreach ($issue in @($issues | Select-Object -First 4)) {
        Write-Output "[$($issue.severity)] $($issue.id): $($issue.summary)"
        Write-Output "  Next: $($issue.nextAction)"
    }
    Write-Output "Next action: $($report.nextAction)"
    if ($OutputPath) {
        Write-Output "Report: $OutputPath"
    }
}

if ($status -eq "blocked") {
    exit 2
}
if ($status -eq "needs_review") {
    exit 1
}
exit 0
