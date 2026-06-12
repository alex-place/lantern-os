<#
.SYNOPSIS
Sync GitHub issues with agent-task labels to dream-journal-v1-agent-slots.json

.DESCRIPTION
Bridges GitHub issue queue to agent slot manifest. Fetches issues labeled
'dream-journal' and 'agent-task', parses structured fields, and updates the
agent slots JSON file for the convergence engine to consume.

.PARAMETER Root
Repository root path (default: parent of scripts directory)

.PARAMETER Owner
GitHub repository owner (default: alex-place)

.PARAMETER Repo
GitHub repository name (default: lantern-os)

.PARAMETER DryRun
Show what would change without writing

.EXAMPLE
.\Sync-GitHubIssuesToAgentSlots.ps1

.EXAMPLE
.\Sync-GitHubIssuesToAgentSlots.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$Owner = "alex-place",
    [string]$Repo = "lantern-os",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = (Resolve-Path "$PSScriptRoot\..\..").Path
} else {
    $Root = (Resolve-Path $Root).Path
}

$SlotsPath = Join-Path $Root "manifests\dream-journal-v1-agent-slots.json"

# Ensure slots file exists
if (-not (Test-Path -LiteralPath $SlotsPath)) {
    $initialSlots = @{
        generated_at = (Get-Date).ToString("o")
        upstream_pr = ""
        strategy = "GitHub issue queue sync via Sync-GitHubIssuesToAgentSlots.ps1"
        token_budget = "max_tokens=1024 per provider call; context slimmed via symbol mesh"
        slots = @()
    }
    $initialSlots | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $SlotsPath -Encoding utf8
    Write-Host "Created initial slots file: $SlotsPath" -ForegroundColor Cyan
}

# Fetch GitHub issues directly via GitHub CLI
Write-Host "Fetching GitHub issues..." -ForegroundColor Cyan
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($null -eq $gh) {
    throw "GitHub CLI (gh) is not installed or not in PATH"
}

$issues = @()
$page = 1
do {
    $query = "repos/$Owner/$Repo/issues?state=all&sort=updated&direction=desc&per_page=100&page=$page"
    $output = @(& gh api $query 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub API error: $($output -join '`n')"
    }
    $pageData = $output | ConvertFrom-Json
    if ($null -eq $pageData -or $pageData.Count -eq 0) {
        break
    }
    $issues += $pageData
    $page++
    if ($pageData.Count -lt 100) {
        break
    }
} while ($page -le 20)

Write-Host "Fetched $($issues.Count) total issues" -ForegroundColor Cyan

# Filter for dream-journal agent-task issues
$targetIssues = @($issues | Where-Object { 
    ($_.labels | ForEach-Object { $_.name }) -contains "dream-journal" -and 
    ($_.labels | ForEach-Object { $_.name }) -contains "agent-task" -and 
    $_.state -eq "open"
})
Write-Host "Found $($targetIssues.Count) open dream-journal agent-task issues" -ForegroundColor Cyan

# Read existing slots
$existingSlots = Get-Content -LiteralPath $SlotsPath -Raw | ConvertFrom-Json
$existingSlotsMap = @{}
foreach ($slot in $existingSlots.slots) {
    $existingSlotsMap[$slot.id] = $slot
}

# Build new slots from GitHub issues
$newSlots = [System.Collections.Generic.List[object]]::new()
$addedCount = 0
$updatedCount = 0
$unchangedCount = 0

foreach ($issue in $targetIssues) {
    $slotId = "github/issue-$($issue.number)"
    
    # Parse priority from labels
    $priorityLabel = @($issue.labels | Where-Object { $_ -match "^p[0-2]$" }) | Select-Object -First 1
    $priority = switch ($priorityLabel) {
        "p0" { 1 }
        "p1" { 2 }
        "p2" { 3 }
        default { 2 }
    }
    
    # Build slot entry
    $slot = [ordered]@{
        id = $slotId
        priority = $priority
        status = "queued"
        type = "github_issue"
        description = $issue.title
        github_issue = @{
            number = $issue.number
            title = $issue.title
            url = $issue.url
            labels = $issue.labels
            created_at = $issue.created_at
            updated_at = $issue.updated_at
        }
    }
    
    # Check if this is a new or updated slot
    if ($existingSlotsMap.ContainsKey($slotId)) {
        $existing = $existingSlotsMap[$slotId]
        if ($existing.github_issue.updated_at -ne $issue.updated_at) {
            $updatedCount++
            Write-Host "  Updated: $($issue.number) - $($issue.title)" -ForegroundColor Yellow
        } else {
            $unchangedCount++
        }
    } else {
        $addedCount++
        Write-Host "  Added: $($issue.number) - $($issue.title)" -ForegroundColor Green
    }
    
    $newSlots.Add([pscustomobject]$slot)
}

# Preserve existing non-GitHub slots (e.g., validation ring)
foreach ($slot in $existingSlots.slots) {
    if (-not $slot.id.StartsWith("github/issue-")) {
        $newSlots.Add($slot)
    }
}

# Update slots manifest
$updatedSlots = @{
    generated_at = (Get-Date).ToString("o")
    upstream_pr = $existingSlots.upstream_pr
    strategy = $existingSlots.strategy
    token_budget = $existingSlots.token_budget
    slots = @($newSlots)
    convergence_loop_result = $existingSlots.convergence_loop_result
    validation_ring = $existingSlots.validation_ring
    notes = "Synced from GitHub issues at $(Get-Date -Format o). $($addedCount) added, $($updatedCount) updated, $($unchangedCount) unchanged."
}

if ($DryRun) {
    Write-Host "`n[DRY RUN] Would update slots file with:" -ForegroundColor Cyan
    Write-Host "  Total slots: $($newSlots.Count)"
    Write-Host "  Added: $addedCount"
    Write-Host "  Updated: $updatedCount"
    Write-Host "  Unchanged: $unchangedCount"
    Write-Host "`nPreview of new slots:" -ForegroundColor Cyan
    $newSlots | Select-Object -First 5 | ForEach-Object { 
        Write-Host "  [$($_.priority)] $($_.id): $($_.description)" 
    }
} else {
    $updatedSlots | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $SlotsPath -Encoding utf8
    Write-Host "`nUpdated slots file: $SlotsPath" -ForegroundColor Green
    Write-Host "  Total slots: $($newSlots.Count)"
    Write-Host "  Added: $addedCount"
    Write-Host "  Updated: $updatedCount"
    Write-Host "  Unchanged: $unchangedCount"
}

Write-Host "`nSync complete." -ForegroundColor Green
