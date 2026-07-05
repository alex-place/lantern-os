### Server crash guards: keep :4177 up through background faults (#2066)

`server.js` registered only SIGTERM/SIGINT — a throw in any background loop or
child-spawn (collectors, mesh IIFE, trainModel, an unawaited promise) crashed the
process while its children kept squatting ports, the documented recurring :4177
downtime. Adds two top-level handlers:

- **`unhandledRejection`** — logs the reason + stack and **keeps serving**, so one
  bad background promise can't take down the listener.
- **`uncaughtException`** — logs the stack, reaps child services (`reapChildren()`,
  so none are orphaned holding ports), then exits non-zero so the watchdog
  (`Watch-DualServers.ps1`, #2058) relaunches cleanly instead of leaving a wedged
  listener with zombie children.

Verified: booted the real server with a preloaded fault-injector that fires a
background `Promise.reject` — the handler logged "server staying up" and
`/api/health` kept returning 200 (Node's default would have terminated). The
uncaughtException path's exit(1) is confirmed in isolation. Loop stage: **Act**
(keep the surface reachable).
