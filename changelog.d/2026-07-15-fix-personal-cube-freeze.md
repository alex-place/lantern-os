### Fixed

- perf: `/api/cubes/alex/personal` no longer freezes the server. The ~9 blocking `execSync` (`gh`/`git`) calls it ran on every dream-chat load (and every 5 min) are now non-blocking async `execFile`, run concurrently, cached for 60s with in-flight de-duplication; the client fetch carries an 8s abort timeout. Concurrent requests stay responsive while it builds — measured: a concurrent `/api/health` returns in ~3ms during a cold 2.8s build, and warm calls return in ~3ms from cache. Also removed the dead `wmic logicaldisk` shell-out (its output was never parsed). (#2492)
