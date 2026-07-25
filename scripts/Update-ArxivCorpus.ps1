<#
.SYNOPSIS
    Daily arXiv corpus delta-harvest + BM25 reindex (#2836).

.DESCRIPTION
    Keeps post-cutoff grounding fresh for !research, chat injection, and the
    patent cross-checks. Runs the two existing steps in the correct order:

        1. scripts/arxiv_harvest.py --delta   (incremental fetch from the last
                                               harvest datestamp)
        2. scripts/arxiv_build_index.py       (rebuild the BM25 index - the step
                                               the #2836 cadence was missing)

    Low value-of-information per run but compounding: without the reindex the
    freshly-harvested papers never enter the retrieval index, so the harvest
    alone does nothing for grounding. This runner is the single unit the daily
    schedule should call.

    Idempotent and safe to run by hand. The reindex only runs if the harvest
    step succeeds; a non-zero exit from either step fails the whole run so a
    scheduler surfaces the error instead of silently serving a stale index.

.PARAMETER PythonExe
    Python interpreter to use. Defaults to 'python' on PATH.

.PARAMETER CorpusDir
    Corpus root. Defaults to $env:ARXIV_CORPUS_DIR, else F:\arxiv-corpus
    (the arxiv_build_index.py default).

.PARAMETER MaxRecords
    Optional cap on new records for a smoke test (passed to --max). Omit for a
    full delta.

.EXAMPLE
    # Run once, by hand:
    powershell -ExecutionPolicy Bypass -File scripts/Update-ArxivCorpus.ps1

.EXAMPLE
    # Register it to run daily at 04:30 (run once, as the operator):
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\micah\lanternos\scripts\Update-ArxivCorpus.ps1"'
    $trigger = New-ScheduledTaskTrigger -Daily -At 4:30am
    Register-ScheduledTask -TaskName 'lantern-arxiv-corpus-daily' -Action $action -Trigger $trigger -Description 'arXiv delta-harvest + BM25 reindex (#2836)'
#>
[CmdletBinding()]
param(
    [string]$PythonExe = 'python',
    [string]$CorpusDir = $(if ($env:ARXIV_CORPUS_DIR) { $env:ARXIV_CORPUS_DIR } else { 'F:\arxiv-corpus' }),
    [int]$MaxRecords = 0
)

$ErrorActionPreference = 'Stop'

# Anchor to the repo root (scripts/..) so relative script paths resolve no
# matter where the scheduler invokes us from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$env:ARXIV_CORPUS_DIR = $CorpusDir
$logDir = Join-Path $CorpusDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "harvest-$stamp.log"

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Write-Log "arXiv corpus update START (corpus=$CorpusDir, python=$PythonExe)"

# --- Step 1: delta harvest ---------------------------------------------------
$harvestArgs = @('scripts/arxiv_harvest.py', '--delta')
if ($MaxRecords -gt 0) { $harvestArgs += @('--max', "$MaxRecords") }

Write-Log ("Step 1/2 harvest: {0} {1}" -f $PythonExe, ($harvestArgs -join ' '))
& $PythonExe @harvestArgs 2>&1 | ForEach-Object { Write-Log ("  harvest| " + $_) }
if ($LASTEXITCODE -ne 0) {
    Write-Log "HARVEST FAILED (exit $LASTEXITCODE) - skipping reindex, index left untouched."
    exit $LASTEXITCODE
}

# --- Step 2: reindex (the #2836 ask - harvest without this does nothing) ------
Write-Log ("Step 2/2 reindex: {0} scripts/arxiv_build_index.py" -f $PythonExe)
& $PythonExe 'scripts/arxiv_build_index.py' 2>&1 | ForEach-Object { Write-Log ("  index| " + $_) }
if ($LASTEXITCODE -ne 0) {
    Write-Log "REINDEX FAILED (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

Write-Log "arXiv corpus update DONE (log: $logFile)"
exit 0
