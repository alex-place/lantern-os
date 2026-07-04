Desktop `.exe` Phase-1 packaging step 2 (ADR-0014): the thin launcher now compiles
to a single `unisona.exe` via Node SEA. `scripts/build-desktop-exe.mjs` (npm
`build:exe`) generates the blob from `desktop/sea-config.json`, copies node, and
injects with a pinned `postject`. Fixes a SEA-correctness bug: a SEA's
`process.execPath` is the exe itself, so the launcher now detects `node:sea` and
spawns the Core with a separate real `node(.exe)` (`UNISONA_NODE_EXE`), and skips
`__dirname` under SEA. Verified on Windows: the built exe boots the Core end-to-end
(HTTP 200 on loopback, chat-only hardened mode). Remaining: sign + installer.
Strengthens Act (local-first delivery channel).
