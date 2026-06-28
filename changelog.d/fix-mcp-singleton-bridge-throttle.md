### Fix: MCP singleton on 8771 + no orphaned grandchildren + bridge spawn throttle

Stray `python src/mcp_server/server.py` instances launched from the MAIN checkout
kept piling up alongside the production stable server's own MCP child, contending
for port 8771 and spawning bursts of `node scripts/tool-runner-bridge.js` — a
RAM spike that contributed to past 4177 OOM crash-loops (see memory
`stable-4177-orphan-leak-502`). Three root causes, three fixes:

- **Singleton guard (`src/mcp_server/server.py`, `server_oauth.py`):** every garage
  `server.js` — the stable production server *and* any dev / `node --watch`
  checkout — unconditionally spawned its own MCP. Two checkouts racing for 8771
  meant the loser crashed on bind or lingered. Both servers now bind-probe the
  port before `uvicorn.run` and, if another MCP already owns it, log and
  `sys.exit(0)` cleanly. Only ONE MCP per port ever runs.
- **No-orphan shutdown (`apps/lantern-garage/server.js`):** on Windows `python`
  re-execs into the real interpreter, so a `SIGTERM` to the direct child orphaned
  the *grandchild* (it kept 8771 and kept spawning bridges); `node --watch`
  leaked one per restart. `server.js` now tracks each MCP child and **tree-kills**
  it (`taskkill /T`) on shutdown, and **probes the port first** so a second
  checkout defers to the existing owner instead of spawning a duplicate.
- **Bridge spawn throttle (`src/mcp_server/shared_tool_bridge.py`):** each tool
  call shells out to a fresh node bridge, run on uvicorn's ~40-slot threadpool, so
  a burst fanned out to ~40 cold-starts at once. A semaphore now caps concurrent
  bridge spawns (`MCP_BRIDGE_MAX_CONCURRENCY`, default 6); excess calls queue.

Verified: a second MCP instance exits 0 via the guard (no uvicorn start); 20
concurrent bridge calls peak at exactly the cap.
