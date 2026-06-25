#!/usr/bin/env powershell
<#
.SYNOPSIS
Register scheduled task for weekly training orchestration.

.DESCRIPTION
Schedules scripts/weekly-training-orchestrator.py to run every Monday at 00:00 UTC.
Automatically dispatches training to all free GPU providers (Kaggle + Lightning).
Runs HumanEval benchmarks and updates GitHub issues with results.

.EXAMPLE
.\scripts\Schedule-WeeklyTraining.ps1 -Server http://127.0.0.1:4177

.PARAMETER Server
Lantern server URL (default: http://127.0.0.1:4177)

.PARAMETER Run
If -Run, execute the training orchestrator immediately instead of scheduling.
#>

param(
    [string]$Server = "http://127.0.0.1:4177",
    [switch]$Run
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OrchestratorScript = Join-Path (Join-Path $RepoRoot "scripts") "weekly-training-orchestrator.py"
$TaskName = "KeystoneWeeklyTraining"

if (-not (Test-Path $OrchestratorScript)) {
    Write-Error "Orchestrator script not found: $OrchestratorScript"
    exit 1
}

# Prepare environment
$env:LANTERN_SERVER_URL = $Server
$githubToken = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")
$env:GITHUB_TOKEN = if ($githubToken) { $githubToken } else { "" }
$hfToken = [System.Environment]::GetEnvironmentVariable("HF_TOKEN", "User")
$env:HF_TOKEN = if ($hfToken) { $hfToken } else { "" }

Write-Host "[*] Weekly Training Orchestrator Setup" -ForegroundColor Cyan
Write-Host "Server: $Server"
Write-Host "Orchestrator: $OrchestratorScript"
Write-Host ""

if ($Run) {
    Write-Host "[>] Running training orchestrator now..." -ForegroundColor Green
    python $OrchestratorScript
    exit $LASTEXITCODE
}

# Create scheduled task
Write-Host "[!] Registering scheduled task: $TaskName" -ForegroundColor Green

$TaskAction = New-ScheduledTaskAction -Execute "python" -Argument $OrchestratorScript -WorkingDirectory $RepoRoot

# Every Monday at 00:00 UTC (adjust for local timezone)
$TaskTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "00:00"

$TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable -RunOnlyIfIdle:$false -MultipleInstances IgnoreNew

# Check if task already exists
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($ExistingTask) {
    Write-Host "  [~] Task exists; updating..." -ForegroundColor Yellow
    Set-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings
}
else {
    Write-Host "  [+] Creating task..." -ForegroundColor Green
    Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings -Description "Keystone weekly training: dispatch to GPU providers, run benchmarks, update issues" | Out-Null
}

Write-Host ""
Write-Host "[OK] Scheduled task created: $TaskName" -ForegroundColor Green
Write-Host "  Schedule: Every Monday at 00:00 UTC"
Write-Host "  Command: python $OrchestratorScript"
Write-Host ""
Write-Host "[i] Environment vars (persist to System/User scope before first run):"
Write-Host "  GITHUB_TOKEN - for updating issues"
Write-Host "  HF_TOKEN - for checkpoint transport"
Write-Host ""
Write-Host "To run manually: $PSScriptRoot\Schedule-WeeklyTraining.ps1 -Run"
Write-Host ""
