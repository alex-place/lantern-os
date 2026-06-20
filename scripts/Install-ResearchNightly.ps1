<#
.SYNOPSIS
  Register (or remove) the nightly Sigma0 open-video research scheduled task, so
  the editor keeps learning editing priors from open-license video on its own.
.DESCRIPTION
  Creates a Windows Scheduled Task that runs scripts/run-research-nightly.ps1
  once a day (download -> analyze -> DELETE -> update editing_priors.json ->
  recalibrate Sigma0 weights). Runs as the current user, normal privileges, only
  while logged in; missed runs fire when the machine next wakes.
.PARAMETER Uninstall
  Remove the task.
.PARAMETER At
  Time of day, HH:mm (default 03:00).
.PARAMETER Limit
  Max clips per run (default 40).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/Install-ResearchNightly.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/Install-ResearchNightly.ps1 -Uninstall
#>
param(
  [switch]$Uninstall,
  [string]$At = "03:00",
  [int]$Limit = 40
)

$ErrorActionPreference = "Stop"
$TaskName = "Lantern-Sigma0-Research-Nightly"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'."
  } else {
    Write-Output "No scheduled task '$TaskName' found."
  }
  return
}

$runner = Join-Path $RepoRoot "scripts\run-research-nightly.ps1"
if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "research\logs") | Out-Null

$psExe = (Get-Command powershell.exe).Source
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Limit $Limit"

$action    = New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $RepoRoot
$trigger   = New-ScheduledTaskTrigger -Daily -At $At
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Nightly Sigma0 open-video research: download -> analyze -> DELETE; updates editing_priors.json and recalibrates Sigma0 weights. Open-license sources only; no video retained." -Force | Out-Null

Write-Output "Registered '$TaskName' - daily at $At, up to $Limit clips/run."
Write-Output "Logs:    research\logs\nightly-*.log"
Write-Output "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Output "Status:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remove:  powershell -ExecutionPolicy Bypass -File scripts\Install-ResearchNightly.ps1 -Uninstall"
