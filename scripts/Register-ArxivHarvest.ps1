<#
.SYNOPSIS
  Register a hidden daily Windows scheduled task that keeps the local arXiv
  recent-research corpus current: runs `arxiv_harvest.py --delta` then
  `arxiv_build_index.py`, logging to $ARXIV_CORPUS_DIR\logs.

.DESCRIPTION
  Mirrors the repo's other repo-managed task registrars. Idempotent — re-running
  updates the existing task. Remove with:
      Unregister-ScheduledTask -TaskName 'KeystoneArxivHarvest' -Confirm:$false

.PARAMETER At
  Daily run time (default 05:30). Pick an off-peak hour; the delta is small.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/Register-ArxivHarvest.ps1
#>
[CmdletBinding()]
param(
  [string]$At = "05:30",
  [string]$TaskName = "KeystoneArxivHarvest",
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CorpusDir = if ($env:ARXIV_CORPUS_DIR) { $env:ARXIV_CORPUS_DIR } else { "F:\arxiv-corpus" }
$LogDir = Join-Path $CorpusDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Wrapper: harvest delta, then rebuild the index. Runs from the repo root so the
# scripts resolve. Appends stdout/stderr to a dated log.
$wrapper = Join-Path $CorpusDir "run-daily-harvest.ps1"
@"
`$ErrorActionPreference = 'Continue'
Set-Location '$RepoRoot'
`$log = Join-Path '$LogDir' ("harvest-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
"=== `$(Get-Date -Format o) delta harvest ===" | Out-File -Append -Encoding utf8 `$log
& '$Python' scripts/arxiv_harvest.py --delta *>> `$log
& '$Python' scripts/arxiv_build_index.py *>> `$log
"=== `$(Get-Date -Format o) done ===" | Out-File -Append -Encoding utf8 `$log
"@ | Set-Content -Encoding utf8 $wrapper

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopOnIdleEnd -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered daily task '$TaskName' at $At."
Write-Host "  wrapper: $wrapper"
Write-Host "  logs:    $LogDir"
Write-Host "Run now with:  Start-ScheduledTask -TaskName '$TaskName'"
