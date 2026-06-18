param(
    [string]$ConfigPath = (Join-Path (Split-Path $PSScriptRoot -Parent) "data\automation\poll-config.json"),
    [switch]$RunOnce
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

function Get-PollConfiguration {
    param([string]$ConfigFile)
    
    if (Test-Path $ConfigFile) {
        try {
            $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
            return $config
        }
        catch {
            Write-Log "Failed to load config: $_" "ERROR"
            return $null
        }
    }
    
    # Return default configuration
    return @{
        sources = @(
            @{
                name = "lantern-os-repo"
                type = "git"
                path = (Split-Path $PSScriptRoot -Parent)
                intervalMinutes = 5
                enabled = $true
            }
            @{
                name = "hff-scan-repo"
                type = "git"
                path = "C:\tmp\human-flourishing-frameworks-scan"
                intervalMinutes = 10
                enabled = $true
            }
            @{
                name = "orchestrator-repo"
                type = "git"
                path = "C:\Users\alexp\Documents\gm-agent-orchestrator"
                intervalMinutes = 15
                enabled = $true
            }
        )
        actions = @(
            @{
                name = "convergence-loop"
                type = "script"
                path = (Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\Invoke-LanternConvergenceLoop.ps1")
                triggerOnChanges = $true
                enabled = $true
            }
            @{
                name = "hff-convergence"
                type = "script"
                path = (Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\Invoke-HFFConvergence.ps1")
                triggerOnChanges = $true
                enabled = $true
            }
        )
    }
}

function Check-GitSource {
    param(
        [object]$Source,
        [ref]$LastStates
    )
    
    $path = $Source.path
    $name = $Source.name
    
    if (-not (Test-Path $path)) {
        Write-Log "Source path does not exist: $path" "WARN"
        return $false
    }
    
    Push-Location $path
    try {
        # Fetch latest
        git fetch origin 2>$null
        
        # Get current HEAD
        $currentHead = git rev-parse HEAD
        $originHead = git rev-parse origin/master 2>$null
        
        # Check for changes
        $hasChanges = ($currentHead -ne $originHead)
        
        $previousState = $LastStates.Value[$name]
        
        if ($hasChanges -and $previousState -ne $originHead) {
            Write-Log "Changes detected in $name"
            $LastStates.Value[$name] = $originHead
            return $true
        }
        
        $LastStates.Value[$name] = $currentHead
        return $false
    }
    catch {
        Write-Log "Error checking $name`: $_" "ERROR"
        return $false
    }
    finally {
        Pop-Location
    }
}

function Trigger-Action {
    param([object]$Action)
    
    if (-not $Action.enabled) {
        return $false
    }
    
    $scriptPath = $Action.path
    if (-not (Test-Path $scriptPath)) {
        Write-Log "Action script not found: $scriptPath" "WARN"
        return $false
    }
    
    Write-Log "Triggering action: $($Action.name)"
    try {
        & $scriptPath
        return $LASTEXITCODE -eq 0
    }
    catch {
        Write-Log "Action failed: $_" "ERROR"
        return $false
    }
}

# Main execution
Write-Log "=== Auto-Poll Scheduler Started ==="

$config = Get-PollConfiguration -ConfigFile $ConfigPath
if (-not $config) {
    Write-Log "Failed to load configuration" "ERROR"
    exit 1
}

$lastStates = @{}
$pollResults = @{}

foreach ($source in $config.sources) {
    if (-not $source.enabled) {
        continue
    }
    
    Write-Log "Checking source: $($source.name)"
    $hasChanges = Check-GitSource -Source $source -LastStates ([ref]$lastStates)
    $pollResults[$source.name] = @{
        hasChanges = $hasChanges
        lastCheck = Get-Date
    }
    
    if ($hasChanges -and $source.triggerOnActions) {
        foreach ($action in $config.actions) {
            if ($action.triggerOnChanges -and $action.enabled) {
                Trigger-Action -Action $action
            }
        }
    }
}

# Store poll results
$resultsPath = (Join-Path (Split-Path $PSScriptRoot -Parent) "data\automation\poll-results.json")
$results = @{
    timestamp = Get-Date -Format "o"
    sources = $pollResults
    lastStates = $lastStates
}
$results | ConvertTo-Json -Depth 10 | Set-Content $resultsPath

Write-Log "=== Auto-Poll Completed ==="

