# LANTERN OS RAG DOLLHOUSE FLAT FILE

Generated: 2026-05-26.

Purpose: single flat RAG-ready index for Lantern OS, COMET LEAP, FOUNDRY,
dual boot, Windows surfaces, server-farm/offline tokens, phone edge nodes,
shareholder packets, and copied literal art/PDF assets.

Remote control plane: `https://github.com/alex-place/lantern-os`

Local control plane: `C:\tmp\lantern-os`

## 0. Truth State

This file is the flat index. It does not claim that all repos were mass-cloned.
It records what is verified locally, what is copied into this skill, and what is
registered only from GitHub metadata.

Current local inspected git repos: 4.

Current named GitHub repo universe: 9.

Current copied RAG-house assets: 8 PDF files, 32 PNG images, 1 SHA256 manifest.

Asset bytes copied into skill at creation: about 1.2 MB.

## 1. Local Inspected Repos

| State | Path | Remote | Dirty State | Role |
|---|---|---|---|---|
| `local_inspected` | `C:\tmp\lantern-os` | `https://github.com/alex-place/lantern-os.git` | dirty during asset build | clean control plane and skill host |
| `local_inspected` | `C:\tmp\human-flourishing-frameworks-scan` | `https://github.com/human-flourishing-frameworks/human-flourishing-frameworks.git` | dirty, 17 changes observed | COMET LEAP PDF/image source |
| `local_inspected` | `C:\Users\alexp\Documents\gm-agent-orchestrator` | `https://github.com/alex-place/gm-agent-orchestrator.git` | dirty, 2 changes observed | local orchestrator source |
| `local_inspected` | `C:\Users\alexp\Documents\lantern-symbolic-sandbox` | `https://github.com/alex-place/lantern-symbolic-sandbox.git` | clean when checked | symbolic Lantern sandbox |

## 2. GitHub Metadata-Only / Not-Yet-Cloned Repos

These repos were registered from GitHub metadata or user-provided repo names.
They are part of the dollhouse universe, but their local working trees were not
present at the checked paths during this pass.

| State | Repo | Default Branch | Privacy | Role |
|---|---|---|---|---|
| `github_metadata_only` | `https://github.com/alex-place/place_co` | `main` | private | web/company surface |
| `github_metadata_only` | `https://github.com/alex-place/ChildOfLevistus` | `master` | private | GameMaker/game source |
| `github_metadata_only` | `https://github.com/alex-place/gamemaker-room-editor` | `main` | private | GameMaker tooling |
| `github_metadata_only` | `https://github.com/alex-place/moneybags` | `master` | public | Java money tooling |
| `github_metadata_only` | `https://github.com/alex-place/SmartBid` | `master` | private | legacy Java bidding app |
| `github_metadata_only` | `https://github.com/alex-place/smartmealplanning` | `main` | private | legacy Java meal planner |

## 3. Copied Literal PDF Assets

Skill asset root: `skills/lantern-rag-dollhouse/assets/pdfs`

| State | Copied Asset | Source Path | Role |
|---|---|---|---|
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-MASTER-PLAN-v2.0.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAP-MASTER-PLAN-v2.0.pdf` | master plan PDF |
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-MASTER-PLAN-v2.1.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAP-MASTER-PLAN-v2.1.pdf` | newer master plan PDF |
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-MINI-BUFFET-30DAY-MERGED.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAP-MINI-BUFFET-30DAY-MERGED.pdf` | 30-day merged model |
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-MINI-BUFFET-30DAY-MERGED-v2.pdf` | `C:\tmp\human-flourishing-frameworks-scan\gdrive-replacement-comet\COMET-LEAP-MINI-BUFFET-30DAY-MERGED-v2.pdf` | replacement 30-day merged model |
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-SPIN-STATE-v1.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAP-SPIN-STATE-v1.pdf` | spin-state artifact |
| `local_asset_copied` | `assets/pdfs/COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.pdf` | `C:\tmp\lantern-os\artifacts\COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.pdf` | Lantern token/revenue convergence PDF |
| `local_asset_copied` | `assets/pdfs/COMET-LEAPER-FOUNDER-MONEY-CONFIDENCE-REPORT-v1.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAPER-FOUNDER-MONEY-CONFIDENCE-REPORT-v1.pdf` | founder money/confidence PDF |
| `local_asset_copied` | `assets/pdfs/COMET-LEAPER-FOUNDER-TRUTH-ONLY-REPORT-v2.pdf` | `C:\tmp\human-flourishing-frameworks-scan\COMET-LEAPER-FOUNDER-TRUTH-ONLY-REPORT-v2.pdf` | truth-only PDF |

## 4. Copied Literal Image Assets

Skill image root: `skills/lantern-rag-dollhouse/assets/images`

30-day COMET LEAP art set copied:

`day_01.png`, `day_02.png`, `day_03.png`, `day_04.png`, `day_05.png`,
`day_06.png`, `day_07.png`, `day_08.png`, `day_09.png`, `day_10.png`,
`day_11.png`, `day_12.png`, `day_13.png`, `day_14.png`, `day_15.png`,
`day_16.png`, `day_17.png`, `day_18.png`, `day_19.png`, `day_20.png`,
`day_21.png`, `day_22.png`, `day_23.png`, `day_24.png`, `day_25.png`,
`day_26.png`, `day_27.png`, `day_28.png`, `day_29.png`, `day_30.png`.

Chart images copied:

- `assets/images/charts/comet_leaper_cash_runway.png`
- `assets/images/charts/comet_leaper_confidence_curve.png`

## 5. Past Convergences Already In Repo

| Commit | Theme | RAG Use |
|---|---|---|
| `718f13c` | Lantern convergence operating loop | method |
| `e98ba8d` | token burn/revenue report and PDF | master PDF source |
| `81e0775` | dual boot readiness clarification | physical install boundary |
| `4475327` | dual boot and Windows surfaces | platform surface |
| `ee6593b` | FOUNDRY shareholder convergence | repo universe |
| `b822a2c` | Matrix RAG dollhouse | architecture |
| `0d3befe` | GitHub repo surface | public/private repo presentation |
| `8a7a349` | latest workflow adds converged | CI and release boundary |
| `0257091` | COMET LEAP agile methodology skill | master PDF update method |

## 6. Dollhouse Rooms

Repo Room: code, manifests, git logs, issues, remotes, dirty state.

PDF/Doc Room: COMET LEAP PDFs, founder reports, truth-only report, token burn
report, master-plan PDFs.

Art Room: 30-day COMET LEAP image sequence and confidence/runway chart images.

Windows Surface Room: feather lantern icon, desktop/start menu launcher bundle,
shareholder HTML index.

Dual-Boot Room: primary PC prep, son-PC readiness packet, rollback docs, NixOS
configuration references.

Server-Farm Room: unmetered local/server-farm Foundry capacity, node inventory
schema, Ollama/Qdrant candidate services.

Phone Edge Room: iPhone and second phone as edge capture/control nodes first.

Shareholder Room: repo universe, confidence tables, money streams, release
readiness gates.

## 7. Retrieval Metadata Policy

Every chunk should carry:

- state: `local_inspected`, `local_asset_copied`, `github_metadata_only`,
  `not_yet_cloned`, or `held`;
- source path;
- copied path when applicable;
- repo URL;
- commit hash when applicable;
- file hash when applicable;
- evidence class;
- confidence;
- operator boundary.

## 8. Future Mass Clone Intake Plan

The following repos are named for future local intake:

1. `https://github.com/alex-place/place_co`
2. `https://github.com/alex-place/ChildOfLevistus`
3. `https://github.com/alex-place/gamemaker-room-editor`
4. `https://github.com/alex-place/moneybags`
5. `https://github.com/alex-place/SmartBid`
6. `https://github.com/alex-place/smartmealplanning`

Clone target should be explicit, likely:

`C:\Users\alexp\Documents\agent-worktrees\foundry-intake\`

Do not clone over existing directories. Do not mutate default branches during
intake. After clone, record git status, remote, branch, languages, and top
artifact paths into this flat file.

## 9. Held Boundaries

v1.0.0 release is held until operator approval.

Dual boot install is held until physical operator action.

True phone dual boot is held until exact model, backup, boot path, legal/security
risk, and rollback are verified.

Cloud token costs are metered with current provider pricing.

Offline/local/server-farm Foundry tokens are unmetered internal capacity.

## 10. Super Jarvis Skill Spine

Top-level router skill:

`skills/super-jarvis-lantern-os/SKILL.md`

Subskills:

- `skills/lantern-rag-dollhouse/SKILL.md`
- `skills/clean-storm-agile/SKILL.md`
- `skills/bayesian-world-model/SKILL.md`
- `skills/comet-leap-agile/SKILL.md`
- `skills/foundry-shareholder/SKILL.md`
- `skills/archive-commons-batch/SKILL.md`

Super Jarvis means one local-first Lantern OS operating spine, not a scattered
set of reports. Its memory body is this flat file plus the literal copied
PDF/image assets.

Printable front page:

`artifacts/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.pdf`

Front-page source:

`reports/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.md`

## 11. Archive / Wayback / Commons Batch Lane

Batching public media uses:

- Internet Archive advanced search metadata;
- Internet Archive item metadata;
- Wayback CDX capture metadata;
- Creative Commons/public-domain/OSS rights signals;
- metadata-first rows before any full media download.

Free music, movies, games, and software must be public-domain, Creative
Commons, open-source, or otherwise clearly redistributable before full asset
ingestion. Wayback captures are evidence/citation metadata, not automatic
permission to republish pages.

Batch script:

`scripts/Invoke-ArchiveCommonsBatch.ps1`

Default output:

`data/archive-commons/latest-results.json`

## 12. Clean Storm Sprint Method

Clean Storm is the repeated lightning agile loop:

`Status -> Fetch -> Scan -> Sort -> Strike -> Trim -> Tighten -> Validate -> Re-scan -> Record -> Ship -> Repeat`

Use it when the operator says to hammer everything and trim fat. It fixes the
first 2-4 actionable issues, preserves real boundaries, and refuses to let fake
placeholders or stale claims survive the sprint.

## 13. Bayesian Real-Time Polled World Model

The dollhouse uses a Bayesian world model for live claims:

`claim -> prior -> poll -> evidence class -> likelihood -> posterior -> decision`

Polling surfaces include local git state, GitHub metadata, skill validation,
PDF extraction, asset hashes, Archive/Wayback metadata, hardware readiness,
server-farm inventory, phone edge state, and v1 gates.

Durable claim ledger:

`data/world-model/belief-ledger.jsonl`

Boundary overrides still win: physical disk actions, true phone boot, public
media rights, and v1.0.0 release approval can remain held even with high
posterior confidence.
