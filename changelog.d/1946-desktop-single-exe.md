Desktop `.exe` is now a single binary — no second bundled Node runtime (#1946).
The prior SEA build spawned a separate `node.exe` to run the Core; `unisona.exe`
is already a full Node runtime, so it now plays both roles. Since a SEA only runs
its embedded entry, the launcher re-execs itself with `UNISONA_CORE=1` and hands
off to the on-disk `server.js` via `createRequire` (real `__dirname`/`node_modules`
resolve against `UNISONA_SERVER_DIR`). Removed `UNISONA_NODE_EXE`; dev path
unchanged. Verified on Windows: boots the Core with no separate node (HTTP 200,
Core child is a second `unisona.exe`). Strengthens Act (leaner local-first delivery).
