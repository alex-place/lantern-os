### Added
- **Chat usage feeds the traction ledger** (#2040, #2041): a successful chat reply
  (streamed + non-streamed) now emits a verified `workflow_used` event to the existing
  traction ledger (`lib/traction.js` → `data/traction/events.jsonl`), keyed on the
  session user's identity so operator dogfooding is excluded from external adoption.
  This gives the already-shipped `/api/traction` summary real MEASURED usage to compute
  activation + retention from — closing the "no funnel telemetry" report-card gap
  without adding a second traction system.
- **/api/health identity fields** (#2037): bare liveness now also returns `branch`,
  `uptime_s`, and `pid` (via shell-free `execFileSync`, 60s branch cache) so a watchdog
  can confirm the right checkout is up on a port before restarting it (supports #2038).
  `?full=1` aggregate unchanged.
