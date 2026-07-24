---
adr: 0014
title: unisona.ai desktop — a thin signed launcher over the one Core, not an Electron repackage
status: Accepted
date: 2026-07-02
deciders: Alex Place
approved-by: Alex Place (2026-07-02)
supersedes: none
superseded-by: none
---

<!--
  Approved in-session by Alex Place on 2026-07-02 ("Write it up as an ADR,
  Status: approved and develop the launcher now"). Per docs/adr/README.md the
  owner may flip status to Accepted; this records that approval.
-->

# ADR-0014: unisona.ai desktop — a thin signed launcher over the one Core, not an Electron repackage

## Status

Accepted — approved by Alex Place (2026-07-02).

## Context

We want a non-developer to run unisona.ai locally by double-clicking something,
instead of `git clone` + `.env` + `make quickstart`. Today `unisona.ai` is a
**brand token** hardcoded across ~49 `public/*.html` titles and a domain that
fronts the local Core; it is not a separate program. The app is already a plain
Node HTTP server ([`server.js`](../../server.js))
that binds `127.0.0.1:4177`, serves static HTML, streams LLM replies over SSE,
and reads/writes JSONL under `data/`.

This forces one honest question against the North Star
([CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md)): a desktop
shell improves **no loop stage** — it is a *delivery channel*, so the Feature
Gate ("name the loop stage you improve, or don't add it") does not by itself
justify it. It earns its place on a different basis: it is the first real
delivery of **foundational principle [12], local-first ownership** (user owns
memory, keys, model choice, machine). And the work it forces — relocating
writable state, storing keys in the OS vault, fixing the loopback privilege model
— strengthens the Core's **Remember** (durable per-user memory location) and
**Act** (secure credential handling) stages for *every* deployment, not just the
desktop one.

A three-seat Σ₀ council (codebase cartographer, external-packaging researcher,
adversarial skeptic) reviewed this. The decisive facts:

- The UI is **already** a browser talking to a localhost server, so we do not
  need a framework that *renders* UI — the user's browser already does.
- The Core depends on **native modules** (`sharp`, `tesseract.js`), which an
  Electron bundle would force us to rebuild against Electron's V8 ABI — for a
  ~150 MB Chromium payload that adds nothing here.
- The proposal's real cost is not "wrap it in an exe"; it is the boring 80% that
  breaks on a virgin machine (no repo-root `.env`, no Windows-env keys, no `data/`
  tree, a hardcoded port, and a loopback-equals-admin model that is safe behind a
  server front door but dangerous on an end-user's box).

Loop stage this touches: primarily **delivery** of principle [12]; the required
hardening touches **Remember** (memory persistence location) and **Act** (secure
key handling).

## Decision

We will ship unisona.ai desktop as a **thin, signed launcher over the one,
unmodified Convergence Core**, staged, under fixed guardrails. It is a **build
artifact of this monorepo, never a fork**.

**Packaging choice:** a native launcher that boots the existing `server.js` and
opens the user's default browser — **not Electron, not Tauri (for now), not a
`pkg` bundle.** Electron is rejected (native-module ABI friction + Chromium
bloat for a UI the browser already renders). A branded Tauri/WebView2 window is a
possible **Phase 2**, only if a first-class window is later judged worth the Rust
toolchain + sidecar cost.

**Phasing:**

- **Phase 1 — the launcher (this ADR's implementation).**
  [`desktop/launcher.js`](../../desktop/launcher.js):
  dependency-free (Node builtins only); picks a free loopback port; spawns
  `server.js` in clean chat-only mode; waits for readiness; opens the default
  browser; tears down the child-process tree on exit. Runs today via `node`
  against a checkout.
- **Phase 0 — Core hardening (must land before any public `.exe`).** Relocate
  writable state to `%APPDATA%\unisona\`; first-run key onboarding storing secrets
  in the Windows Credential Manager / DPAPI (`safeStorage`); require an explicit
  local token so loopback is no longer implicitly admin. These are Core changes
  that benefit all deployments.
- **Phase 1-package — the signed `.exe`.** Ship a plain Node runtime + app
  directory + a Node-SEA-compiled `unisona.exe`; sign + distribute via the $0
  channels in the **2026-07-04 Update** below (MSIX-via-Store primary + SignPath
  Foundation for direct download — **not** Azure); wrap in an installer targeting
  `%LOCALAPPDATA%\unisona`.

**Guardrails (binding conditions):**

- **G1 — One Core.** The launcher boots *unmodified* `server.js`. No forked
  server. If it needs Core changes, they land in the shared Core for everyone.
- **G2 — Relocate state** to a per-user OS app-data dir before shipping (Phase 0).
- **G3 — Keys in the OS vault**, user-supplied; never plaintext, never embedded
  in the binary (Phase 0).
- **G4 — Fix the loopback privilege model** before shipping (Phase 0).
- **G5 — No Electron.** Reuse the user's browser; if a window is ever wanted, use
  the OS WebView (Tauri), justified in a new ADR.
- **G6 — Signed or no auto-update.** Authenticode-signed binaries + signed update
  manifests, or ship without self-update. No unsigned self-update channel.
- **G7 — Bundle runtime only.** Exclude git hooks, worktrees, `pr-watcher`,
  auto-deploy, dual-boot scripts, and the optional Python `src/` children.
- **G8 — Name it honestly.** "unisona" here is the brand/skin of the one Core;
  it must not silently become a second product, and must not be confused with the
  separate "unisona local model" (8 GB coder) plan.

## Consequences

- **Positive:** delivers principle [12] to non-developers for the first time;
  avoids the Electron footgun (size + native-module rebuilds); the launcher is
  ~200 lines of zero-dependency Node; the forced Phase-0 hardening (AppData
  relocation, key vault, loopback auth) improves the Core's security and
  portability regardless of the desktop app; a free-port + loopback-only boot
  removes the 4177 collision and public-bind foot-guns.
- **Negative / trade-offs:** Phase 1 is only meaningful on a checkout until
  Phase 0 lands (the Core still uses repo-relative paths and repo-root `.env`);
  the signed `.exe` needs a paid signing subscription and a reputation-building
  period on SmartScreen; a browser tab is less "app-like" than a dedicated window
  (accepted for now; Phase 2 revisits); the launcher must track server.js env
  gates (documented inline with `server.js:line` references so drift is visible).
- **Follow-ups:**
  - Phase 0 hardening issues: AppData state relocation; Credential-Manager key
    onboarding UI; loopback local-token auth.
  - Phase 1-package: Node SEA build (✅ done, #1992) + signing/distribution via the
    2026-07-04 Update channels (MSIX-Store + SignPath) + installer.
  - Optional tray icon (Stop / Restart / Open) — pure launcher polish.
  - Decide Phase 2 (Tauri window) yes/no once Phase 1 is in real use.

## Alternatives considered

- **Electron + electron-builder** — rejected: bundles ~150 MB of Chromium the
  user's browser already provides, and forces rebuilding `sharp`/`tesseract.js`
  against Electron's ABI. Its mature updater doesn't outweigh that here.
- **Tauri + Node sidecar** — deferred to a possible Phase 2: the small-binary
  advantage largely evaporates once a full Node runtime is shipped as a sidecar,
  and it adds a Rust toolchain + WebView2 dependency. Reconsider only if a
  first-class window becomes worth it.
- **`pkg` single binary** — rejected: `vercel/pkg` is deprecated, and `.node`
  native addons (sharp/tesseract) are the exact case single-file bundlers handle
  worst. Node SEA (ship node + app dir) is the chosen packaging path instead.
- **"Just repackage the whole app as unisona.ai"** — rejected: that framing is
  how a domain quietly becomes a second codebase (forbidden "independent
  ecosystem" / sprawl). The exe must be a build artifact of the one Core (G1).
- **Do nothing (keep clone + make quickstart)** — rejected: that is a developer
  ritual, not a product; it never delivers principle [12] to real users.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Core is a plain Node server binding `127.0.0.1:4177`, port via `LANTERN_GARAGE_PORT`/`PORT` | [`server.js:78-79`](../../server.js#L78) | High | repo |
| Setting `PORT` flips the bind to `0.0.0.0` (public) — launcher must avoid it | [`server.js:79`](../../server.js#L79) | High | repo |
| Clean chat-only mode gates: MCP `LANTERN_MCP_SERVER=false`, OAuth `LANTERN_MCP_OAUTH=false` | [`server.js:426`](../../server.js#L426), [`:435`](../../server.js#L435) | High | repo |
| Trading off via `LANTERN_DISABLE_TRADING=1`; tunnel off via `LANTERN_CLOUDFLARE_TUNNEL=false` | [`server.js:440`](../../server.js#L440), [`:486`](../../server.js#L486) | High | repo |
| Core reads `.env.local`/`.env` from repo root (breaks on a virgin machine) | [`server.js:45-57`](../../server.js#L45) | High | repo |
| Core has native-module deps that complicate bundling (`sharp`, `tesseract.js`) | [`package.json:53-54`](../../package.json#L53) | High | repo |
| Node engine requirement is `>=20` | [`package.json:39-41`](../../package.json#L39) | High | repo |
| Optional children (Discord/crypto-observer/pr-watcher) already default OFF | [`server.js:320`](../../server.js#L320), [`:609`](../../server.js#L609), [`:714`](../../server.js#L714) | High | repo |
| `unisona.ai` is a brand token / second domain over the same Core, not a program | memory [[unisona-second-domain]]; `docs/UNISONA-1.8.md` | High | repo + memory |
| Loopback requests are treated as local-admin (unsafe on an end-user box) | memory [[lantern-net-cloudflare-bypass]], [[api-auth-gaps-2026-06-20]] | Medium | memory |
| EV certs no longer bypass SmartScreen (removed 2024) | Microsoft Learn — SmartScreen reputation (learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) | High | web |
| `vercel/pkg` deprecated; Node SEA is the current single-executable path | github.com/vercel/pkg; nodejs.org SEA docs | High | web |

## Update — 2026-07-04: signing & distribution channel (research, Alex)

The original "sign via Azure Artifact Signing (~$10/mo)" follow-up is **superseded**.
Grounded research corrected two premises and settled the channels; **we ship both.**

**Premise corrections:**
- **EV certificates stopped granting instant SmartScreen reputation in 2024**, so
  paying for EV/Azure buys a signature + a *slow reputation ramp*, not a
  warning-free first launch. Azure Trusted Signing → renamed **Artifact Signing**
  (GA ~Apr 2026) needs a **paid** Azure sub (free/sponsored subs blocked) and uses
  that same ramp. **Azure is dropped** — strictly worse than the $0 options.
- **Cloudflare and Google/Vertex credits cannot sign a Windows exe.** Cloudflare
  issues *web* TLS certs only; Google CAS issues *private* (untrusted) CA certs and
  Cloud HSM only stores keys. Code signing needs a cert chaining to Microsoft's
  Trusted Root Program, which neither provides.

**Decision — two $0 channels (repo is public → both eligible):**
1. **Microsoft Store (MSIX) — primary.** $0; Microsoft **re-signs on
   certification** so users see **no SmartScreen warning on first launch**; auto-
   updates; no cert to manage. Store registration is free (individuals Sep 2025,
   companies May 2026).
2. **SignPath Foundation — for direct download off unisona.ai.** $0 free OSS OV
   signing (key on their HSM, Sectigo cert). Caveats: SmartScreen publisher reads
   **"SignPath Foundation"**, and reputation still ramps over downloads.

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| EV certs no longer grant instant SmartScreen reputation (2024) | knowledge.digicert.com — EV-signed apps still show SmartScreen warnings | High | web |
| MS Store re-signs MSIX → no first-launch warning; registration now free | learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options; blogs.windows.com (free registration Sep 2025 / May 2026) | High | web |
| SignPath Foundation = free OSS signing; public repos eligible | signpath.org ; signpath.org/terms.html | High | web |
| Cloudflare / Google credits don't cover Windows code signing | developers.cloudflare.com/ssl (web certs only); Google CAS = private CA | High | web + product scope |

## Update — 2026-07-10: native WebView2 shell replaces the Edge `--app` window (amends G5)

**Status: Proposed (pending Alex's approval per the ADR gate).** Directed by Alex
("it should not be edge, I want a native desktop app").

**What changed.** G5 originally said: reuse the user's browser; if a window is ever
wanted, use Edge/Chrome `--app` mode. In practice that launched **`msedge.exe`** — an
actual browser process (browser profile, app-mode address bar, an Edge dependency and
Edge update surface). It read as a browser, not an app.

**Decision.** Keep the principle behind G5 — **no bundled Chromium, no Electron** — but
render the window with a **native .NET WPF + WebView2 shell** (`Unisona.exe`,
[`desktop/shell/`](../../desktop/shell/)) instead
of spawning the Edge browser. WebView2 is the Edge *engine* already on Win10/11 (same
"reuse what's installed" spirit; still no ~150 MB Chromium download), but the window is a
genuine native app — own process, title bar, taskbar entry, dark immersive chrome, no
address bar, no `msedge.exe`. This is the same move Microsoft made for new Teams
(Electron → WebView2). The **one-Core rule (G1) is unchanged**: the shell replaces *only*
the window; it boots the same unmodified Core via `launcher.js --embed`.

**Architecture.** Two executables now ship (still no `node.exe`, no Chromium):
`Unisona.exe` (the shell) spawns `unisona-core.exe` (the Node SEA backend) with `--embed`;
the Core hands back the tokened loopback endpoint via `%LOCALAPPDATA%\unisona\endpoint.json`
and the shell hosts it in WebView2. Tauri was reconsidered (per the original "reconsider
Tauri" note) but WebView2-via-.NET builds and verifies on the existing Windows/.NET
toolchain with no new Rust build system.

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Native shell boots the packaged Core with **zero `node.exe`** and serves the cockpit | 2026-07-10 install test: `Unisona.exe → unisona-core.exe --embed → unisona-core.exe`, `http://127.0.0.1:*/` → 200, `<title>unisona.ai</title>` | High (measured) | local install run |
| WebView2 engine is present on Win10/11 (no Chromium download) | WebView2 Evergreen Runtime 150.x on the build box; MS ships it in-box on Win11 | High | local + learn.microsoft.com |
| New Microsoft Teams moved Electron → WebView2 for a native window | learn.microsoft.com / Teams engineering posts | Medium | web |
