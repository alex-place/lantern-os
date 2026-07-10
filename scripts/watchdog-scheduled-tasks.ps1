# Watchdog: re-enable critical Windows scheduled tasks if they get left Disabled.
#
# NOTE: this is the TRACKED REFERENCE copy. The copy that actually runs lives at
#   C:\dev\watchdog-scheduled-tasks.ps1   (OUTSIDE the repo, on purpose -- same
# reason as scripts/auto-deploy-stable.ps1: automation does `git checkout` /
# `git reset --hard` on the main checkout between turns, which must never be able
# to touch the script a live scheduled task is mid-run inside).
# Driven by the Windows scheduled task `KeystoneTaskWatchdog` (every 20 min).
# Keep the two copies in sync by hand. Log: C:\dev\watchdog-scheduled-tasks.log
#
# 2026-06-30 incident: KeystoneAutoDeployStable (the task that keeps the stable
# :4177 / lantern-os.net worktree current with origin/master) was found silently
# Disabled -- LastTaskResult was 0 (it did not fail, something just flipped
# Enabled=false on the task, not the trigger). No task re-enables itself, so the
# stable worktree sat 8+ commits behind master for ~8 hours with nobody the wiser
# until the in-app "update available" banner was pointed out. This watchdog is
# the fix: an independent task that periodically checks the deploy task's
# Settings.Enabled and flips it back on if it ever goes false again, so a repeat
# of the same failure mode self-heals within one tick instead of needing a human
# to notice a stale banner.
$ErrorActionPreference = 'Continue'
$LOG = 'C:\dev\watchdog-scheduled-tasks.log'
# Tasks that must always stay enabled for unisona.ai to keep running/deploying
# itself. Deliberately NOT the full Lantern-* task list -- several of those
# (LanternBackendWatchdog8766, LanternChatWatchdog, LanternDreamJournal,
# Lantern-KalshiNightlyAnalysis) were disabled together on 2026-06-21, which
# looks like an intentional consolidation, not a failure -- re-enabling them
# blind could restart bots/watchers the user turned off on purpose. Only add a
# task here once its disablement is confirmed to be unintentional.
$CRITICAL_TASKS = @('KeystoneAutoDeployStable')

if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 2MB)) { Move-Item $LOG "$LOG.1" -Force -ErrorAction SilentlyContinue }
function Log($m) {
  $line = "{0}  {1}" -f (Get-Date).ToString('s'), $m
  Add-Content -Path $LOG -Value $line
}

foreach ($name in $CRITICAL_TASKS) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { Log "$name -> not found (skip)"; continue }
  if ($task.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $name | Out-Null
    Log "$name -> was Disabled, re-enabled"
  }
}
