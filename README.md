# Lantern OS

Status: pre-v1.0.0 staging  
Scope: local-first operating repo, surfaces, reports, manifests, and release gates  
Style spine: `docs/ORION-MOOKMANREPORT4-STYLE.md`  
Operator boundary: local MCP status, dirty worktrees, private folders, boot mutation, and live worker counts require operator-machine evidence

---

## Open Lantern

Primary local dashboard:

```text
http://127.0.0.1:4177
```

This is the front door for interaction: first-class chat, RAG memory, wallet
truth, local controls, outreach, reports, devices, diagnostics, cloud mirrors,
and Arc Reactor Mining Lab converge here. No setup screen or secondary launcher
is required when the dashboard is already running. No separate mining dashboard,
no shortcut sprawl, no fake surfaces.

Windows tester download path:

```text
https://github.com/alex-place/lantern-os/releases/latest
```

Use `Lantern-OS-Free-Setup.exe` for the free tester lane or
`Lantern-OS-Founder-20-Setup.exe` for the $20 founder tester lane. The install
wiki is `docs/wiki/WINDOWS-TESTER-INSTALL.md`. Do not claim an `.exe` is ready
unless that release asset exists on GitHub; use the ZIP tester packet as the
fallback until the release build is actually attached.

---

## Simple Answer

Lantern OS is the clean control plane for the Windows/local-first Lantern line.

The repo is not a dump of every prior artifact. It is the place where promoted work becomes readable, validated, public-safe, and ready for the next operator step.

Repo = evidence store. Surface = fast access. Together they reduce confusion.

---

## What It Actually Does

| Lane | Purpose | Current state |
|---|---|---|
| Local cockpit | Open operator surfaces for app, garage, RAG, wallet, boot gates, and reports | present |
| RAG Dollhouse | Keep source-labeled flat memory and receipts | present |
| Release gates | Prevent v1 claims before proof and operator approval | active |
| MCP split | Separate remote docs from local-only health and worker proof | active |
| Agent contact | Tell agents what to inspect first and what to hold | active |
| Orion style | Convert flat docs and CSS into human-readable technical sheets | active style pass |

---

## Evidence / Source Discipline

Source repos remain authoritative until promoted:

```text
C:\tmp\human-flourishing-frameworks-scan
C:\Users\alexp\Documents\gm-agent-orchestrator
```

Remote control plane:

```text
https://github.com/alex-place/lantern-os
```

Core maps:

```text
manifests/foundry-shareholder-repos.md
docs/wiki/ALEX-PLACE.md
docs/ORION-MOOKMANREPORT4-STYLE.md
```

---

## Proven / Held / Local-Only

| State | Meaning |
|---|---|
| Proven in repo | File exists here and can be reviewed through GitHub or local checkout |
| Held local-only | Requires the operator machine: MCP health, dirty worktrees, private folders, local queue/active/failed state, live worker counts |
| Design contract | Describes intended system shape, not live proof |
| Public-safe | Avoids private identity, raw dumps, unsafe fabrication details, and fake live-state claims |

Nothing becomes v1.0.0 merely because it exists elsewhere. Promotion requires the convergence loop in `docs/CONVERGENCE-LOOP.md`.

---

## Initial Surfaces

| Surface | Path |
|---|---|
| Canonical Lantern dashboard | `http://127.0.0.1:4177` |
| Lantern Garage app | `apps/lantern-garage/` |
| Cloud mirror manifest | `manifests/cloud-mirrors.json` |
| Redirected legacy surfaces | `surfaces/shareholder-index/index.html`, `surfaces/tony-garage/index.html`, `surfaces/lantern-desktop/index.html` |
| Agent initial-contact surface | `manifests/LANTERN-OS-AGENT-INITIAL-CONTACT-SURFACES.md` |
| Arc Reactor status | `data/arc-reactor/status.json` |
| Arc Reactor Mining Lab | `docs/ARC-REACTOR-MINING-LAB.md` |
| Flat Lantern RAG Dollhouse | `skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md` |
| Orion / Mookman Report 4 style | `docs/ORION-MOOKMANREPORT4-STYLE.md` |

---

## One Dashboard

Lantern OS uses one dashboard with internal cards and formatted document views.
Do not add a new public dashboard for every product lane. Internal cards/routes
should be backed by real files, validation receipts, or live APIs.

The dashboard should always make chat first-class, keep cloud tunnel/mirror
status visible, and route Markdown through the formatted Lantern reader instead
of dropping operators into raw text docs.

---

## Cloud Mirrors

`master` is the canonical worktree and deploy branch until v1.0.0. Cloud URLs
are mirrors of the same Lantern OS dashboard, not separate products or extra
dashboards.

Mirror policy:

- Local primary: `http://127.0.0.1:4177`
- AWS/service mirrors live in `manifests/cloud-mirrors.json`
- AWS uses `apps/lantern-garage/cloud-server.js` and
  `apps/lantern-garage/Dockerfile`
- Local Windows uses `apps/lantern-garage/server.js`
- A mirror can be listed as `candidate`, `configured`, or `verified`; the UI
  must show that status plainly

Execution boundary: until v1.0.0, executable work must stay in the AWS-safe
deploy/check lane or the Kalshi public-data research lane. See
`docs/EXECUTION-BOUNDARIES.md`.

---

## Brand Guidelines

Lantern OS should feel like a local operator cockpit: calm, evidence-backed,
warm, and usable under pressure.

Brand rules:

- One front door: use `http://127.0.0.1:4177` as the local interaction URL.
- Local first: default to localhost, repo-backed files, and explicit operator
  control before cloud or tunnels.
- Truth first: cards appear only when backed by files, validation receipts, or
  live APIs.
- No fake dashboards: use one dashboard with internal cards/routes.
- No secret collection: never ask for seed phrases, private keys, Apple ID
  credentials, exchange passwords, or hidden signing permissions.
- Plain language: say what is ready, held, blocked, or experimental.
- Visual style: light cockpit surface, deep ink text, Lantern teal `#08756f`,
  steel blue `#1e5f89`, amber warnings `#9f5a07`, and rose risk `#9a3d55`.

---

## Arc Reactor Mining Lab

Mining Lab is a safe, legal, local-first package for inventorying owned
hardware, routing hardware into viable lanes, validating wallets in read-only
mode, and producing receipts.

Mining boundaries:

- CPU routes to Monero learning/P2Pool checks.
- GPU routes stay experimental for RVN or ETC.
- BTC/LTC/DOGE/KAS require owned or separately justified dedicated hardware.
- ETH is wallet/claim/read-only only, not a mining lane.
- No wallet cracking, brute force, hidden signing, or fake one-shot ROI claims.

---

## Release Rule

Before adding new surfaces, run the loop and fix the first 2-4 open issues it finds. Expansion is allowed only after the leading blockers are handled or explicitly marked held by the operator.

Fleet execution uses the 12x3 convergence-ring contract in `manifests/CONVERGENCE-LOOP-AGENT-FLEET.md`: 12 loop steps, 3 agent roles per step, 36 designed ring slots, and a 64-worker elastic pool target. This is a design and receipt contract, not live-worker proof.

MCP work is split by `manifests/MCP-WORK-SPLIT.md`. Remote docs can validate contracts and receipts, but local-only MCP health, dirty worktrees, private folders, and live worker counts still require operator-machine evidence.

---

## Receptionist Routing

Use `docs/LANTERN-OS-RECEPTIONIST-CALL-LIST.md` for public-safe call routing. It uses organization switchboards and public program contacts only. Do not add personal phone numbers, scraped direct dials, or unverified private numbers.

---

## Printable Reports

Quick front page:

```text
artifacts/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.pdf
```

Master convergence PDF:

```text
artifacts/COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.pdf
```

Public bounty radar:

```text
artifacts/PUBLIC-PUZZLE-MATH-BOUNTY-RADAR-2026-05-30.pdf
```

---

## Non-Goals For This Repo

- No unattended bootloader edits.
- No partition or disk mutation scripts.
- No unreviewed generated artifact dump.
- No claim that v1.0.0 is ready before the operator says so.
- No skeleton-only milestones.
- No treating offline/local/server-farm Foundry tokens as cloud-metered, "Lite", or per-token rated.
- No raw filepath spam above the first human-relevant explanation.

---

## First Command

Run the convergence loop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LanternConvergenceLoop.ps1
```

Validate the convergence fleet count contract:

```powershell
python .\scripts\Test-ConvergenceAgentFleet.py --write-json .\manifests\validation\CONVERGENCE-FLEET-LATEST.json
```

---

## Garage Command

Open the Movie 1 operator cockpit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-TonyGarage.ps1
```

If the browser shows stale styling, reopen through the launcher or refresh with cache bypass. The garage surface cache-busts its CSS, image, and document links.

---

## Local Controls Command

Open the local control bridge and validate dashboard/MCP/Lantern health:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternLocalControls.ps1
```

---

## Full-Stack App Command

Start the in-house Lantern Garage app:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternGarageApp.ps1
```

Then open:

```text
http://127.0.0.1:4177
```
