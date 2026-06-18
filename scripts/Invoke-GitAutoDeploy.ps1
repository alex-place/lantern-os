param(
    [string]$RepoPath = (Split-Path $PSScriptRoot -Parent),
    [string]$Branch = "master",
    [int]$PollIntervalMinutes = 5,
    [switch]$Continuous
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

function Sync-GitRepo {
    param([string]$Path, [string]$TargetBranch)
    
    Write-Log "Starting git sync for $TargetBranch branch"
    
    Push-Location $Path
    
    try {
        # Stash any local changes
        Write-Log "Stashing local changes"
        $stashResult = git stash push -m "auto-deploy-stash-$(Get-Date -Format 'yyyyMMddHHmmss')"
        
        # Fetch latest changes
        Write-Log "Fetching from origin"
        git fetch origin
        
        # Switch to target branch
        Write-Log "Switching to $TargetBranch branch"
        git checkout $TargetBranch
        
        # Pull latest changes
        Write-Log "Pulling latest changes from origin/$TargetBranch"
        $pullResult = git pull origin $TargetBranch
        
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Successfully pulled latest changes"
            return $true
        } else {
            Write-Log "Pull failed with exit code $LASTEXITCODE" "ERROR"
            return $false
        }
    }
    catch {
        Write-Log "Error during git sync: $_" "ERROR"
        return $false
    }
    finally {
        Pop-Location
    }
}

function Get-RepoChanges {
    param([string]$Path)
    
    Push-Location $Path
    try {
        $logResult = git log --oneline -1 HEAD 2>$null
        if ($LASTEXITCODE -eq 0) {
            return $logResult
        }
        return $null
    }
    finally {
        Pop-Location
    }
}

function Deploy-Changes {
    param([string]$Path, [string]$Changes)
    
    Write-Log "Processing deployment for changes"
    
    # Check for deployment scripts
    $deployScript = Join-Path $Path "scripts\deploy.ps1"
    if (Test-Path $deployScript) {
        Write-Log "Running deployment script"
        try {
            & $deployScript
            return $LASTEXITCODE -eq 0
        }
        catch {
            Write-Log "Deployment script failed: $_" "ERROR"
            return $false
        }
    }
    
    # Default deployment: trigger CI/CD
    Write-Log "No custom deployment script, changes will trigger CI/CD"
    return $true
}

# Main execution loop
Write-Log "=== Git Auto-Deploy Started ==="
Write-Log "Repository: $RepoPath"
Write-Log "Branch: $Branch"
Write-Log "Poll Interval: $PollIntervalMinutes minutes"

if (-not (Test-Path $RepoPath)) {
    Write-Log "Repository path does not exist: $RepoPath" "ERROR"
    exit 1
}

do {
    $syncSuccess = Sync-GitRepo -Path $RepoPath -TargetBranch $Branch
    
    if ($syncSuccess) {
        $changes = Get-RepoChanges -Path $RepoPath
        if ($changes) {
            Write-Log "Detected changes:"
            Write-Log $changes
            
            $deploySuccess = Deploy-Changes -Path $RepoPath -Changes $changes
            if ($deploySuccess) {
                Write-Log "Deployment successful"
            } else {
                Write-Log "Deployment failed" "ERROR"
            }
        } else {
            Write-Log "No new changes detected"
        }
    } else {
        Write-Log "Git sync failed, will retry next cycle" "ERROR"
    }
    
    if ($Continuous) {
        Write-Log "Next poll in $PollIntervalMinutes minutes..."
        Start-Sleep -Seconds ($PollIntervalMinutes * 60)
    }
} while ($Continuous)

Write-Log "=== Git Auto-Deploy Completed ==="
