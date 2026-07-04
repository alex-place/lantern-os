# unisona.ai desktop launcher

A **thin launcher** that lets a non-developer run the unisona.ai / Keystone OS
Convergence Core locally: double-click → the Core boots on a private loopback
port → a **standalone app window** opens at it (no console window). Your memory,
your keys, your machine.

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
- Waits until the server actually answers, then opens the UI as a **standalone,
  chromeless app window** — Edge/Chrome `--app` mode (the WebView2 engine already on
  Windows; **no bundled Chromium** — ADR-0014 G5). Falls back to the default browser
  if neither is found.
- **Windowless**: the shipped exe is GUI-subsystem — **no console window** — so logs
  go to `%LOCALAPPDATA%\unisona\logs\desktop.log`, not a terminal.
- **Closing the app window** quits the app and tears down the **whole child-process
  tree** (also `Ctrl+C` in dev). No orphaned headless server.

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

## Building the shipped `.exe`

The launcher runs today via `node`. Turning it into a **signed, double-clickable
`.exe`** is deliberately staged, because the Core depends on **native modules**
(`sharp`, `tesseract.js`) that must match the bundling runtime's ABI. ADR-0014
records the decision **against Electron** (native-module rebuild friction + a
150 MB Chromium the user's browser already provides) in favour of shipping **one
Node runtime (the exe itself) + the app directory + a small signed launcher**.

We ship **exactly one executable.** `unisona.exe` is a full Node runtime with the
launcher embedded, so it can play both roles: the launcher, and — re-invoked with
`UNISONA_CORE=1` — the Node runtime that runs the Core's `server.js`. No second
`node.exe` is bundled. The app *code* (`server.js`, `lib/`, `public/`, and
`node_modules` incl. the native `sharp`/`tesseract.js` binaries) still ships as
files on disk, because native `.node` addons cannot live inside a SEA blob.

Build steps (ADR-0014 §Follow-ups):

1. **App resources** *(installer step — pending)*: lay the `apps/lantern-garage`
   tree (incl. prebuilt `sharp`/`tesseract.js` binaries for `win32-x64`) beside the
   exe. **No `node.exe`** — `unisona.exe` is the runtime.
2. **Compile `launcher.js` → `unisona.exe`** — ✅ **wired**, via Node **SEA** (not
   `pkg`, which is deprecated):
   ```bash
   node scripts/build-desktop-exe.mjs
   # or: npm run build:exe --prefix apps/lantern-garage/desktop
   # → apps/lantern-garage/desktop/dist/unisona.exe
   ```
   Because a SEA's `process.execPath` **is** `unisona.exe` (its embedded entry is
   the launcher, not a generic node), `unisona.exe server.js` can't run the Core.
   So the launcher instead **re-execs itself** with `UNISONA_CORE=1`; that second
   instance's embedded entry hands off to the on-disk `server.js` via
   `createRequire` (its real `__dirname`/`node_modules` resolve against
   `UNISONA_SERVER_DIR`). One binary, both roles. [`sea-config.json`](sea-config.json)
   holds the SEA config and `postject` (a pinned build dep) injects the blob.
   *Verified on Windows:* the built exe boots the Core end-to-end with **no separate
   node** — `server.js` answers HTTP 200 on loopback in chat-only hardened mode, and
   the Core child is a second `unisona.exe`, not a `node.exe`.
3. **Sign — pick a channel** (`postject` invalidates the copied runtime's original
   signature, so the exe/package MUST be (re)signed to be trusted). Research
   2026-07-04 (Alex) settled the channels — **we ship BOTH:**
   - **Microsoft Store (MSIX) — primary, $0, no warning.** Package as MSIX and ship
     through the Store; Microsoft **re-signs on certification**, so users see **no
     SmartScreen warning on first launch** and there is no cert to manage. Store
     registration is now free (individuals since Sep 2025, companies since May 2026).
   - **SignPath Foundation — direct download off unisona.ai, $0.** Free OSS OV
     signing; this repo is **public → eligible**. Two caveats: the SmartScreen
     publisher reads **"SignPath Foundation"** (not "Unisona"), and — like every
     cert path — it builds reputation over downloads before the warning clears.
   - **NOT Azure Trusted / Artifact Signing.** It is *paid* (requires a paid Azure
     sub) and, since **EV certs stopped granting instant SmartScreen reputation in
     2024**, it buys the *same* reputation ramp as the free options — strictly worse.
     Dropped. (Cloudflare and Google/Vertex credits cannot sign a Windows exe
     either — different certificate type.)
4. **Installer / package** — for the SignPath direct-download channel, ✅ **wired**
   via **Inno Setup** ([`unisona.iss`](unisona.iss), driven by
   [`scripts/build-desktop-installer.mjs`](../../../scripts/build-desktop-installer.mjs)):
   ```bash
   node scripts/build-desktop-installer.mjs
   # or: npm run build:installer --prefix apps/lantern-garage/desktop
   # → apps/lantern-garage/desktop/dist/Unisona-Setup-<version>.exe
   ```
   It stages the payload with the repo-mirroring layout (`resources/app` = the garage
   app, `src/` + root `node_modules` at the install root, so the Core's
   `../../../src` requires resolve), then compiles a **per-user** installer (no admin,
   no UAC) that lays the app into `%LOCALAPPDATA%\unisona`. **No `node.exe`** —
   `unisona.exe` is the runtime. A **completeness guard** fails the build if any
   declared dependency is absent from the staged `node_modules`, so a bundle that
   won't boot can't ship. *Verified on Windows:* build → silent-install → the
   installed `unisona.exe` boots the Core (HTTP 200 on loopback) → clean uninstall.
   **Build prereqs:** Inno Setup 6 (`winget install JRSoftware.InnoSetup`) and a
   checkout with a complete `npm ci` — built from a checkout with **no running
   server** (a live server holds `node_modules` handles and the copy skips them).
   The **MSIX / Microsoft-Store** channel is separate (Store handles install+update).

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
