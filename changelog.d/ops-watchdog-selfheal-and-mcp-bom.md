# ops: watchdog self-heal + MCP BOM tolerance

**Loop stage: Verify** (operational health — the healer can no longer silently stop healing).

- `Watch-DualServers.ps1`: singleton guard (blind relaunch is now safe — a duplicate
  looping watchdog exits instead of stacking), per-sweep heartbeat file
  (`logs/watchdog-heartbeat.txt` distinguishes a live loop from a dead one or a
  `-Once` run), and `-RegisterTask` which installs the `LanternWatchdogRevive`
  scheduled task (every 15 min) so a dead looping watchdog is revived automatically.
- `src/mcp_server/server.py`: fleet-status and agents-config reads now use
  `utf-8-sig`, fixing the recurring `Could not read fleet status file: Unexpected
  UTF-8 BOM` warning caused by PowerShell `Out-File` BOMs.
