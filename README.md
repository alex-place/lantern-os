# Lantern OS

Fresh repository for the Lantern OS v1.0.0 line.

Lantern OS is the clean convergence target for the Windows, local-first, NixOS,
COMET LEAP, and household AI surfaces. This repo starts as a staging and release
control plane, not a dump of every prior artifact.

## Current Status

Status: pre-v1.0.0 staging

This repo is ready to receive promoted artifacts when the operator decides the
v1.0.0 line is ready. Until then, source repos remain authoritative:

- `C:\tmp\human-flourishing-frameworks-scan`
- `C:\Users\alexp\Documents\gm-agent-orchestrator`

Remote control plane: `https://github.com/alex-place/lantern-os`

Shareholder/repo consolidation map:
`manifests/foundry-shareholder-repos.md`

## Release Rule

Nothing becomes v1.0.0 here merely because it exists elsewhere. Promotion
requires the Lantern OS convergence loop in
`docs/CONVERGENCE-LOOP.md`.

Before adding new surfaces, run the loop and fix the first 2-4 open issues it
finds. Expansion is allowed only after the leading blockers are handled or
explicitly marked held by the operator.

## Initial Surfaces

- Windows desktop/start-menu launcher bundle
- Shareholder HTML index at `surfaces/shareholder-index/index.html`
- Tony Garage operator cockpit at `surfaces/tony-garage/index.html`
- Lantern Garage full-stack app at `apps/lantern-garage/`
- Arc Reactor confidence skill at `skills/arc-reactor-confidence/SKILL.md`
- Arc Reactor status at `data/arc-reactor/status.json`
- Store release lanes at `manifests/STORE-RELEASE-LANES.md`
- v1 readiness test at `reports/V1-READINESS-TEST-2026-05-26.md`
- Old workstreams/repo map at `manifests/OLD-WORKSTREAMS-AND-REPOS.md`
- Printable Super Jarvis front page at `artifacts/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.pdf`
- Gage school art packet at `school-packets/gage-high-intel-art/GAGE-HIGH-INTEL-ART-PACKET.zip`
- COMET LEAP 11-day cash sprint at `reports/COMET-LEAP-11-DAY-CASH-SPRINT.md`
- Product universe atlas at `reports/LANTERN-PRODUCT-UNIVERSE-ATLAS.md`
- One World Leader app skill at `skills/one-world-leader-app/SKILL.md`
- COMET LEAP agile methodology skill at `skills/comet-leap-agile/SKILL.md`
- Flat Lantern RAG dollhouse skill at `skills/lantern-rag-dollhouse/SKILL.md`
- Super Jarvis Lantern OS router skill at `skills/super-jarvis-lantern-os/SKILL.md`
- Clean Storm Agile sprint skill at `skills/clean-storm-agile/SKILL.md`
- Bayesian world-model skill at `skills/bayesian-world-model/SKILL.md`
- Archive/Wayback/commons batch skill at `skills/archive-commons-batch/SKILL.md`
- NixOS dual-boot configuration path
- COMET LEAP 30-day model artifact manifest
- Buffett/COMET LEAP planning document references
- Lantern app/runtime surface references

## Printable Report

Use this front page for quick print/share:

```text
artifacts/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.pdf
```

Master convergence PDF:

```text
artifacts/COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.pdf
```

## Non-Goals For This Repo

- No unattended bootloader edits.
- No partition or disk mutation scripts.
- No unreviewed generated artifact dump.
- No claim that v1.0.0 is ready before the operator says so.
- No skeleton-only milestones.
- No treating offline/local/server-farm Foundry tokens as cloud-metered,
  "Lite", or per-token rated.

## First Command

Run the convergence loop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LanternConvergenceLoop.ps1
```

## Garage Command

Open the Movie 1 operator cockpit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-TonyGarage.ps1
```

If the browser shows stale styling, reopen through the launcher or refresh with
cache bypass. The garage surface cache-busts its CSS, image, and document links.

## Local Controls Command

Open the local control bridge and validate dashboard/MCP/Lantern health:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternLocalControls.ps1
```

## Full-Stack App Command

Start the in-house Lantern Garage app:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternGarageApp.ps1
```

Then open:

```text
http://127.0.0.1:4177
```
