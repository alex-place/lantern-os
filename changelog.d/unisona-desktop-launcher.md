feat(desktop): unisona.ai desktop launcher — thin, dependency-free (ADR-0014)

New `apps/lantern-garage/desktop/launcher.js` boots the one, unmodified Core
(`server.js`) in clean chat-only mode on a free loopback port, waits until it
answers, then opens the user's default browser at it — no bundled Chromium, no
forked server. Uses only Node builtins. It picks a free port (no fixed-4177
collision), forces a `127.0.0.1` bind (deletes `PORT`, sets
`LANTERN_GARAGE_HOST`), disables the Python MCP children / trading service /
Cloudflare tunnel via the documented env gates, and tears down the whole
child-process tree on Ctrl+C. Run with `npm run desktop --prefix
apps/lantern-garage` or double-click `desktop/Unisona.cmd`.

This is a delivery channel for the local-first principle (North Star [12]), not
a new subsystem: it boots the same Core, so it adds no loop stage. The decision,
its guardrails (G1 one-Core … G8 naming), the rejection of Electron, and the
staged Phase-0 hardening (AppData state, OS-vault keys, loopback auth) required
before a signed `.exe` ships are recorded in
[docs/adr/0014-unisona-desktop-launcher.md](docs/adr/0014-unisona-desktop-launcher.md)
(Accepted, Alex Place 2026-07-02).
