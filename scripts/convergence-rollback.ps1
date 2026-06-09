#Requires -Version 7
<#
.SYNOPSIS
    Tag the last known good commit based on convergence receipts.

.DESCRIPTION
    Scans manifests/evidence/ for convergence receipts where promotion_ready=true.
    Tags the corresponding commit with convergence-good-<sha> for quick rollback.

.PARAMETER DryRun
    Show what would be tagged without creating tags.

.PARAMETER RepoRoot
    Path to the repository root. Defaults to the script's parent directory.

.EXAMPLE
    .\scripts\convergence-rollback.ps1
    # Tags the most recent promotion-ready commit

.EXAMPLE
    .\scripts\convergence-rollback.ps1 -DryRun
    # Shows what would be tagged without creating
#>
param(
    [switch]$DryRun,
    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

function Find-PromotionReceipts {
    $evidenceDir = Join-Path $RepoRoot "manifests" "evidence"
    if (-not (Test-Path $evidenceDir)) {
        Write-Warning "Evidence directory not found: $evidenceDir"
        return @()
    }

    $receipts = Get-ChildItem -Path $evidenceDir -Filter "convergence-*.json" -File |
        Sort-Object LastWriteTime -Descending

    $goodCommits = @()
    foreach ($r in $receipts) {
        try {
            $data = Get-Content $r.FullName -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($data.promotion_ready -eq $true) {
                # Receipts don't store commit SHA directly; we approximate by receipt time
                # In CI, this script runs immediately after the loop, so HEAD is the commit
                $goodCommits += [PSCustomObject]@{
                    Receipt = $r.Name
                    Timestamp = $r.LastWriteTime
                    PromotionReady = $data.promotion_ready
                    Score = $data.convergence_score
                }
            }
        } catch {
            Write-Warning "Failed to parse $($r.Name): $_"
        }
    }
    return $goodCommits
}

function Get-CommitAtTime {
    param([DateTime]$Timestamp)
    # Find the commit that was HEAD at approximately this time
    $formatted = $Timestamp.ToString("yyyy-MM-dd HH:mm:ss")
    $result = git -C $RepoRoot log --oneline --no-decorate -1 --before="$formatted" 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) {
        $sha = ($result -split '\s')[0]
        return $sha
    }
    return $null
}

# ── Main ──

Write-Host "Convergence Rollback — finding last known good commits" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"

$goodReceipts = Find-PromotionReceipts
if ($goodReceipts.Count -eq 0) {
    Write-Warning "No promotion-ready convergence receipts found."
    Write-Host "Run the convergence loop first: python src/convergence_io_engine.py loop"
    exit 1
}

Write-Host "Found $($goodReceipts.Count) promotion-ready receipt(s):" -ForegroundColor Green
$goodReceipts | Select-Object -First 5 | Format-Table Receipt, Timestamp, Score

$latest = $goodReceipts | Select-Object -First 1
$sha = Get-CommitAtTime -Timestamp $latest.Timestamp

if (-not $sha) {
    Write-Error "Could not determine commit for receipt time $($latest.Timestamp)"
    exit 1
}

$tagName = "convergence-good-$sha"
$existingTags = git -C $RepoRoot tag -l "convergence-good-*" 2>$null

Write-Host ""
Write-Host "Latest good commit: $sha" -ForegroundColor Cyan
Write-Host "Tag name: $tagName" -ForegroundColor Cyan
Write-Host "Existing convergence-good tags: $($existingTags.Count)" -ForegroundColor Gray

if ($DryRun) {
    Write-Host "[DRY RUN] Would tag $sha as $tagName" -ForegroundColor Yellow
} else {
    # Force-move the tag if it exists (it's a moving bookmark)
    git -C $RepoRoot tag -f $tagName $sha 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Tagged $sha as $tagName" -ForegroundColor Green
    } else {
        Write-Error "Failed to tag $sha"
        exit 1
    }

    # Optionally push to origin
    $push = Read-Host "Push tag to origin? (y/N)"
    if ($push -eq "y") {
        git -C $RepoRoot push origin $tagName --force-with-lease 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Pushed $tagName to origin" -ForegroundColor Green
        } else {
            Write-Warning "Push failed; tag exists locally only"
        }
    }
}

Write-Host ""
Write-Host "Rollback commands:" -ForegroundColor Cyan
Write-Host "  git log --oneline $($tagName)~5..$tagName    # Show recent good commits"
Write-Host "  git checkout -b rollback-$sha $($tagName)  # Create rollback branch"
Write-Host "  git reset --hard $tagName                    # Reset to last good"
