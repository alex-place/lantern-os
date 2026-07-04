# unisona.ai desktop launcher

A **thin launcher** that lets a non-developer run the unisona.ai / Keystone OS
Convergence Core locally: double-click → the Core boots on a private loopback
port → your default browser opens at it. Your memory, your keys, your machine.

> **Design decision:** [docs/adr/0014-unisona-desktop-launcher.md](../../../docs/adr/0014-unisona-desktop-launcher.md).
> This is a **delivery channel** for the local-first principle, **not** a new
> subsystem. It boots the *one, unmodified* [`server.js`](../server.js) — it does
> not fork the Core.

## What it does (Phase 1)

- Picks a **free loopback port** (never a fixed 4177 that could collide).
- Spawns the existing `server.js` in **clean chat-only mode** — no Python MCP
  children, no trading microservice, no Cloudflare tunnel.
- Binds **127.0.0.1 only** (it deletes `PORT` and sets `LANTERN_GARAGE_HOST` so
  the Core can never accidentally bind `0.0.0.0`).
- Waits until the server actually answers, then opens your **default browser**
  (no bundled Chromium — see ADR-0014, guardrail G5).
- `Ctrl+C` tears down the **whole child-process tree** (`taskkill /T` on Windows).

It uses **only Node builtins** — zero dependencies — so it can be wrapped into a
single executable later without dragging in a dependency tree.

## Run it now (dev)

From a checkout that has had `npm install` run in `apps/lantern-garage`:

```bash
# from the repo
node apps/lantern-garage/desktop/launcher.js
# or, on Windows, double-click:
apps\lantern-garage\desktop\Unisona.cmd
```

Point it at a *different* checkout (e.g. testing this launcher from a worktree
against the main checkout that has `node_modules`):

```bash
UNISONA_SERVER_DIR="C:/dev/lantern-os/apps/lantern-garage" node launcher.js
```

### Flags / env

| Flag | Env | Effect |
|---|---|---|
| `--port N` | `LANTERN_GARAGE_PORT` | Force a port instead of auto-picking |
| `--page /x.html` | `UNISONA_LANDING_PAGE` | Which page to open (default `/`) |
| `--no-open` | `UNISONA_NO_OPEN=1` | Boot the server but don't open a browser |
| — | `UNISONA_SERVER_DIR` | Folder containing `server.js` |
| — | `UNISONA_READY_TIMEOUT_MS` | Readiness-poll budget (default 45000) |

## Building the shipped `.exe` (Phase 1 packaging — not yet wired)

The launcher runs today via `node`. Turning it into a **signed, double-clickable
`.exe`** is deliberately staged, because the Core depends on **native modules**
(`sharp`, `tesseract.js`) that must match the bundling runtime's ABI. ADR-0014
records the decision **against Electron** (native-module rebuild friction + a
150 MB Chromium the user's browser already provides) in favour of shipping a
**plain Node runtime + app directory + a small signed launcher**.

Planned build (tracked as a follow-up, see ADR-0014 §Follow-ups):

1. Ship `node.exe` (LTS) + the `apps/lantern-garage` tree (incl. prebuilt
   `sharp`/`tesseract.js` binaries for `win32-x64`) as app resources.
2. Compile `launcher.js` to `unisona.exe` (Node SEA, `--build-sea`; **not**
   `pkg`, which is deprecated). The launcher points `UNISONA_SERVER_DIR` at the
   bundled resources.
3. **Sign** with Azure Artifact Signing (~$10/mo). Note: EV certs no longer
   bypass SmartScreen (Microsoft removed that in 2024) — reputation builds over
   download volume regardless.
4. Installer (Inno Setup / MSIX) that lays the app into `%LOCALAPPDATA%\unisona`.

## Phase 0 hardening (see ADR-0014) — foundations landed (#1946)

These are Core changes that must land **before** a public `.exe` ships. They are
not launcher concerns — they harden the Core for everyone. The three **seams** are
now in place and behaviour-preserving (default off); the remaining work is routing
call sites through them and flipping the launcher on.

- **State relocation (G2)** — ✅ seam landed: [`lib/app-paths.js`](../lib/app-paths.js)
  is the one place that decides where writable state lives. Default is
  `<repoRoot>/data` (unchanged); `UNISONA_DESKTOP=1` relocates to
  `%APPDATA%\unisona\data`. `lib/tenant.js` already sources its `DATA_ROOT` here.
  *Remaining:* route the remaining direct `data/` call sites (server.js,
  dreamer-store, …) through it.
- **OS credential vault (G3)** — ✅ landed: [`lib/key-vault.js`](../lib/key-vault.js)
  stores keys DPAPI-encrypted at `<stateRoot>/keys.vault.json`; `tenant.js` reads
  it as a fallback when no env key is present. *Remaining:* first-run key-onboarding
  UI.
- **Loopback ≠ admin (G4)** — ✅ mechanism landed: [`lib/request-auth.js`](../lib/request-auth.js)
  gates operator trust on a per-boot `UNISONA_LOCAL_TOKEN` when set. *Remaining:*
  client fetch-header adoption, then have the launcher mint + pass the token.
