param(
    [string]$HffRepoPath = "C:\tmp\human-flourishing-frameworks-scan",
    [string]$LanternRepoPath = (Split-Path $PSScriptRoot -Parent),
    [switch]$DryRun,
    [switch]$ForceConvergence
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

function Test-RepoReady {
    param([string]$Path)
    
    if (-not (Test-Path $Path)) {
        Write-Log "Repository path does not exist: $Path" "WARN"
        return $false
    }
    
    Push-Location $Path
    try {
        # Check if it's a git repo
        git rev-parse --git-dir 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
    finally {
        Pop-Location
    }
}

function Get-HffChanges {
    param([string]$HffPath)
    
    Push-Location $HffPath
    try {
        Write-Log "Fetching HFF repository changes"
        git fetch origin 2>$null
        
        $localHead = git rev-parse HEAD
        $originMaster = git rev-parse origin/master 2>$null
        
        if ($localHead -ne $originMaster) {
            Write-Log "HFF repo has changes: $localHead -> $originMaster"
            
            # Get log of changes
            $changes = git log --oneline $localHead..origin/master
            return @{
                hasChanges = $true
                localHead = $localHead
                originHead = $originMaster
                changes = $changes
            }
        }
        
        return @{
            hasChanges = $false
            localHead = $localHead
            originHead = $originMaster
        }
    }
    finally {
        Pop-Location
    }
}

function Sync-HffRepo {
    param([string]$HffPath, [bool]$Force)
    
    Push-Location $HffPath
    try {
        if ($Force) {
            Write-Log "Force syncing HFF repository"
            git reset --hard origin/master
        } else {
            Write-Log "Merging HFF repository changes"
            git pull origin master
        }
        return $LASTEXITCODE -eq 0
    }
    catch {
        Write-Log "Error syncing HFF repo: $_" "ERROR"
        return $false
    }
    finally {
        Pop-Location
    }
}

function Analyze-HffState {
    param([string]$HffPath, [string]$LanternPath)
    
    Push-Location $HffPath
    try {
        Write-Log "Analyzing HFF repository state"
        
        # Check for dirty state
        $status = git status --porcelain
        $isDirty = $status.Length -gt 0
        
        # Get current branch
        $branch = git rev-parse --abbrev-ref HEAD
        
        # Check for uncommitted changes
        $uncommitted = git diff --name-only
        $unstaged = git diff --name-only --cached
        
        return @{
            isDirty = $isDirty
            branch = $branch
            uncommittedFiles = $uncommitted
            unstagedFiles = $unstaged
            status = $status
        }
    }
    finally {
        Pop-Location
    }
}

function Promote-HffArtifacts {
    param([string]$HffPath, [string]$LanternPath, [bool]$DryRun)
    
    Write-Log "Promoting HFF artifacts to Lantern OS"
    
    # Look for HFF artifacts that should be promoted
    $hffArtifactsDir = Join-Path $HffPath "artifacts"
    $lanternArtifactsDir = Join-Path $LanternPath "artifacts"
    
    if (Test-Path $hffArtifactsDir) {
        Write-Log "Found HFF artifacts directory"
        
        if (-not (Test-Path $lanternArtifactsDir)) {
            New-Item -ItemType Directory -Path $lanternArtifactsDir -Force | Out-Null
        }
        
        # Copy artifacts (dry run if specified)
        $artifacts = Get-ChildItem $hffArtifactsDir -File
        foreach ($artifact in $artifacts) {
            if ($DryRun) {
                Write-Log "[DRY RUN] Would copy: $($artifact.Name)"
            } else {
                Copy-Item $artifact.FullName -Destination $lanternArtifactsDir -Force
                Write-Log "Copied artifact: $($artifact.Name)"
            }
        }
        
        return $artifacts.Count
    }
    
    return 0
}

function Generate-ConvergenceReport {
    param(
        [string]$HffPath,
        [string]$LanternPath,
        [hashtable]$HffState,
        [hashtable]$Changes
    )
    
    $reportPath = Join-Path $LanternPath "manifests\hff-convergence-report-$(Get-Date -Format 'yyyy-MM-dd').md"
    
    $report = @"
# HFF Convergence Report

**Generated**: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
**HFF Repo**: $HffPath
**Lantern Repo**: $LanternPath

## HFF Repository State

- **Branch**: $($HffState.branch)
- **Dirty**: $($HffState.isDirty)
- **Uncommitted Files**: $($HffState.uncommittedFiles.Count)
- **Unstaged Files**: $($HffState.unstagedFiles.Count)

## Changes Detected

- **Has Changes**: $($Changes.hasChanges)
- **Previous HEAD**: $($Changes.localHead)
- **New HEAD**: $($Changes.originHead)

## Convergence Actions

@(if ($Changes.hasChanges) {
"- Repository sync completed"
"- Artifacts promoted"
"- Convergence loop triggered"
} else {
"- No changes detected"
})

## Next Actions

1. Review promoted artifacts
2. Run convergence loop validation
3. Update manifests if needed
4. Commit convergence report
"@
    
    $report | Set-Content $reportPath
    Write-Log "Generated convergence report: $reportPath"
    return $reportPath
}

# Main execution
Write-Log "=== HFF Convergence Automation Started ==="

# Check repositories
$hffReady = Test-RepoReady -Path $HffRepoPath
$lanternReady = Test-RepoReady -Path $LanternRepoPath

if (-not $hffReady) {
    Write-Log "HFF repository not ready: $HffRepoPath" "ERROR"
    exit 1
}

if (-not $lanternReady) {
    Write-Log "Lantern OS repository not ready: $LanternRepoPath" "ERROR"
    exit 1
}

# Analyze current state
$hffState = Analyze-HffState -HffPath $HffRepoPath -LanternPath $LanternRepoPath
Write-Log "HFF State: $($hffState.branch), Dirty: $($hffState.isDirty)"

# Check for changes
$changes = Get-HffChanges -HffPath $HffRepoPath

if ($changes.hasChanges -or $ForceConvergence) {
    Write-Log "Convergence required"
    
    if (-not $DryRun) {
        # Sync repository
        $syncSuccess = Sync-HffRepo -HffPath $HffRepoPath -Force $ForceConvergence
        
        if ($syncSuccess) {
            # Promote artifacts
            $artifactsCopied = Promote-HffArtifacts -HffPath $HffRepoPath -LanternPath $LanternRepoPath -DryRun $DryRun
            Write-Log "Promoted $artifactsCopied artifacts"
            
            # Trigger convergence loop
            Write-Log "Triggering Lantern convergence loop"
            & (Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\Invoke-LanternConvergenceLoop.ps1")
        }
    } else {
        Write-Log "[DRY RUN] Would sync HFF repository and promote artifacts"
        Promote-HffArtifacts -HffPath $HffRepoPath -LanternPath $LanternRepoPath -DryRun $true
    }
} else {
    Write-Log "No convergence required"
}

# Generate report
$reportPath = Generate-ConvergenceReport -HffPath $HffRepoPath -LanternPath $LanternRepoPath -HffState $hffState -Changes $changes

Write-Log "=== HFF Convergence Completed ==="