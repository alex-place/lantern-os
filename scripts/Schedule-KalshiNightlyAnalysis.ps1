# Schedule-KalshiNightlyAnalysis.ps1
# Registers a Windows Task Scheduler job that runs kalshi_tightband_analysis.py
# nightly at 23:00 UTC (after MLB game windows close).
#
# Run once as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\Schedule-KalshiNightlyAnalysis.ps1
#
# To verify:  Get-ScheduledTask -TaskName "Lantern-KalshiNightlyAnalysis"
# To remove:  Unregister-ScheduledTask -TaskName "Lantern-KalshiNightlyAnalysis" -Confirm:$false

$TaskName  = "Lantern-KalshiNightlyAnalysis"
$RepoRoot  = Split-Path $PSScriptRoot -Parent
$Script    = Join-Path $RepoRoot "experiments\kalshi_tightband_analysis.py"
$LogFile   = Join-Path $RepoRoot "data\kalshi\nightly-analysis.log"

# Detect python from PATH; fall back to py launcher
$Python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue)?.Source }
if (-not $Python) { throw "Python not found on PATH. Install Python 3.10+ and retry." }

$Action  = New-ScheduledTaskAction -Execute $Python `
               -Argument "`"$Script`" >> `"$LogFile`" 2>&1" `
               -WorkingDirectory $RepoRoot

# 23:00 UTC daily — Task Scheduler uses local time; offset for UTC
$UtcOffset = [System.TimeZoneInfo]::Local.GetUtcOffset([datetime]::Now).TotalHours
$LocalHour = (23 + $UtcOffset) % 24
$Trigger   = New-ScheduledTaskTrigger -Daily -At ([string]$LocalHour + ":00")

$Settings  = New-ScheduledTaskSettingsSet `
               -StartWhenAvailable `
               -RunOnlyIfNetworkAvailable:$false `
               -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
               -MultipleInstances IgnoreNew

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited

# Remove old task if present, then register fresh
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   $Trigger `
    -Settings  $Settings `
    -Principal $Principal `
    -Description "Kalshi tight-band CIO accuracy analysis (issue #425). Runs nightly at 23:00 UTC after MLB game windows close. Appends to data/kalshi/cio-accuracy-log.jsonl."

Write-Host "Scheduled task '$TaskName' registered."
Write-Host "  Python : $Python"
Write-Host "  Script : $Script"
Write-Host "  Log    : $LogFile"
Write-Host "  Trigger: daily at local ${LocalHour}:00 (= 23:00 UTC)"
