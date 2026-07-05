### Stable-server watchdog: identity-aware /api/health probe + boot-health ledger (#2038)

Extend the existing dual-boot watchdog (`scripts/Watch-DualServers.ps1`) instead of
adding a second one:

- **Probe `/api/health` (was `/api/version`)** — the endpoint carries `{branch, pid,
  uptime_s}` identity (#2037). A dead port (`000`/non-200) **or** the wrong branch
  squatting `:4177` (stable must serve `master`) now both count as unhealthy, so a
  stale/wrong checkout on the port triggers a relaunch of the right server.
- **Structured `data/boot-health.jsonl` ledger** — one append-only JSON line per action
  (`{ts, action, port, outcome}`; actions: `down_probe`, `restart`, `recover`,
  `restart_skipped`) for offline aggregation, alongside the human-readable
  `logs/watchdog.log`. Runtime-only, gitignored.

No-thrash preserved (a healthy sweep on a healthy server writes nothing; restart still
needs N consecutive fails). Verified with a live `-Once` sweep: `000` on `:4177` wrote
exactly one `down_probe` line and did not restart on the first fail. Loop stage: **Act**
(keep the surface reachable).
