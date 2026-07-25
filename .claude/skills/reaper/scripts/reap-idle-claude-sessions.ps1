# Reaper: kill IDLE, OLD headless claude-code agent sessions to stop RAM sprawl.
#
# Context (2026-07-04): on this 12GB box the #1 RAM/CPU drain was ~30 orphaned
# headless `claude-code ... --output-format stream` sessions (children of the
# Claude desktop app) that accumulated over ~27h with no reaper. Killing the
# idle ones took RAM 92%->65% and commit 31GB->16GB. This script prevents
# re-accumulation. Driven by the scheduled task `KeystoneClaudeReaper`.
#
# Lives OUTSIDE the repo (same reason as C:\dev\watchdog-scheduled-tasks.ps1):
# automation does `git reset --hard` on the main checkout between turns and must
# never be able to clobber a script a live scheduled task is mid-run inside.
#
# SAFE BY DESIGN — a session is killed ONLY if BOTH are true:
#   1. age > ThresholdHours (default 8)  -> not a recent/active session
#   2. CPU did not advance over a 3s sample -> truly idle, not mid-generation
# An actively streaming session moves CPU and is spared even if old. The Claude
# desktop app itself and its Electron --type= helpers never match the filter, so
# they are never touched. Interactive sessions left idle > ThresholdHours WILL be
# reaped (they can be reopened; this is the intended RAM reclaim).
#
# Usage:  pwsh -File reap-idle-claude-sessions.ps1 [-ThresholdHours 8] [-DryRun]

param(
  [double]$ThresholdHours = 8,
  [double]$CpuIdleDeltaSec = 0.15,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$LOG = 'C:\dev\reap-idle-claude-sessions.log'
if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 2MB)) { Move-Item $LOG "$LOG.1" -Force -ErrorAction SilentlyContinue }
function Log($m) { Add-Content -Path $LOG -Value ("{0}  {1}" -f (Get-Date).ToString('s'), $m) }

$now = Get-Date

# Headless claude-code CLI agent sessions only (never the desktop app / Electron helpers).
$sessions = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  Where-Object { $_.CommandLine -like '*claude-code*--output-format*' }

if (-not $sessions) { Log "no claude-code sessions present"; return }

# First CPU sample.
$cpu1 = @{}
foreach ($s in $sessions) {
  $p = Get-Process -Id $s.ProcessId -ErrorAction SilentlyContinue
  if ($p) { $cpu1[$s.ProcessId] = $p.CPU }
}
Start-Sleep -Seconds 3
# Second CPU sample + decide.
$killed = 0; $spared = 0
foreach ($s in $sessions) {
  $p = Get-Process -Id $s.ProcessId -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $ageHrs = ($now - $p.StartTime).TotalHours
  $delta  = if ($cpu1.ContainsKey($s.ProcessId)) { $p.CPU - $cpu1[$s.ProcessId] } else { 999 }
  $idle   = ($delta -lt $CpuIdleDeltaSec)
  $old    = ($ageHrs -gt $ThresholdHours)
  if ($old -and $idle) {
    $wsMB = [math]::Round($p.WS/1MB,0)
    if ($DryRun) {
      Log ("DRYRUN would-kill PID {0} age={1}h idle(dCPU={2}s) WS={3}MB" -f $s.ProcessId, [math]::Round($ageHrs,1), [math]::Round($delta,2), $wsMB)
    } else {
      try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop
            Log ("KILLED PID {0} age={1}h idle WS={2}MB" -f $s.ProcessId, [math]::Round($ageHrs,1), $wsMB); $killed++ }
      catch { Log ("FAILED PID {0}: {1}" -f $s.ProcessId, $_.Exception.Message) }
    }
  } else {
    $spared++
  }
}
Log ("done: killed={0} spared={1} threshold={2}h dryrun={3}" -f $killed, $spared, $ThresholdHours, [bool]$DryRun)
