# ops: child-process resilience (report-card remediation, part 2)

**Loop stage: Verify** (operational health).

- `server.js`: CryptoObserver now relaunches with exponential backoff (max 6
  attempts, counter resets after 10 min of uptime) instead of dying silently and
  leaving a training-data gap until the next server restart.
- `lib/news-collector.js`: RSS fetch retries once after 2s before giving up,
  recovering Yahoo's transient "socket hang up" drops.
- `src/mcp_server/server.py` + `server_oauth.py`: the singleton bind-probe had a
  TOCTOU race — port free at probe, taken by uvicorn's bind — that dumped a raw
  `Errno 10048` traceback into the err logs. Both now catch the bind OSError and
  exit with the same clean one-line singleton message.
