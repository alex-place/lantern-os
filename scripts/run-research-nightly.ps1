<#
.SYNOPSIS
  One nightly batch of the Sigma0 open-video research flywheel
  (download -> analyze -> DELETE -> learn). Invoked by the scheduled task;
  safe to run by hand too.
.NOTES
  Skips gracefully (exit 0) if the research code is not on the checked-out
  branch, so a registered task never errors loudly before the PRs are merged.
#>
param([int]$Limit = 40)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$logDir = Join-Path $RepoRoot "research\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("nightly-" + (Get-Date -Format "yyyy-MM-dd_HHmmss") + ".log")
function Log($m) { ("[" + (Get-Date -Format o) + "] " + $m) | Add-Content -Path $log -Encoding utf8 }

$script = Join-Path $RepoRoot "scripts\open-video-research.js"
if (-not (Test-Path $script)) {
  Log "research code (scripts/open-video-research.js) not present on the checked-out branch. Merge the research PRs first. Skipping."
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log "node not found on PATH. Skipping."; exit 0 }

Log ("starting nightly open-video research (limit " + $Limit + ")")
& $node "scripts\open-video-research.js" "--nightly" ("--limit=" + $Limit) 2>&1 |
  ForEach-Object { $_ | Out-String } | Add-Content -Path $log -Encoding utf8
Log ("finished (node exit " + $LASTEXITCODE + ")")
