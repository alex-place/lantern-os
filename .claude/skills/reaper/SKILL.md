---
name: reaper
description: Reclaim RAM by killing IDLE, OLD headless claude-code agent sessions (the measured #1 RAM drain — 30 orphans took the box 92%→65%). Use when the user types /reaper or !reaper, says "reap sessions", "kill orphaned claude sessions", "free up RAM", "the box is slow/at 90% RAM", or at end-of-day cleanup. Replaces the removed KeystoneClaudeReaper scheduled task (operator, 2026-07-24) — on-demand now.
---

# Reaper — reclaim RAM from orphaned agent sessions

Runs [scripts/reap-idle-claude-sessions.ps1](scripts/reap-idle-claude-sessions.ps1). **Safe by
design** — a session dies ONLY if BOTH hold: age > 8h AND CPU did not advance over a 3s sample
(actively-streaming sessions are spared; the desktop app and its Electron helpers never match the
filter). NEVER kill the session you are running in — the filter can't match you (you're active),
but do not lower `-ThresholdHours` below ~1.

## Run

1. **Dry-run first, always** — report what WOULD die (PID, age, RAM):
   `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/reaper/scripts/reap-idle-claude-sessions.ps1 -DryRun`
2. Show the user the list. If it's non-empty and looks right (no session they're using), run
   without `-DryRun`.
3. Report: killed / spared counts + RAM before/after (`Get-CimInstance Win32_OperatingSystem`
   FreePhysicalMemory). Log: `C:\dev\reap-idle-claude-sessions.log`.

Also check for orphaned background MODEL jobs (the other measured drain): python processes
holding >1GB with no active task — report them, kill only with user confirmation.
