# Lantern OS Master Push RAG House Plan

Date: 2026-05-26  
Repository: `alex-place/lantern-os`  
Target branch: `master`  
Mode: direct master documentation update  
Operator profile: `!super jarvis is !perfect`

## Current Master Evidence

Latest observed master commit before this report:

```text
12580110bed9729975079821657a9d2e2b10a769
chore: refresh Lantern Garage validation receipts
```

That commit refreshed validation receipts under:

```text
manifests/validation/LANTERN-GARAGE-APP-LATEST.json
manifests/validation/TONY-GARAGE-SURFACE-LATEST.json
```

The repo README defines Lantern OS as the clean convergence target and release control plane for Windows, local-first, NixOS, COMET LEAP, and household AI surfaces. The current repo already contains app surfaces, skills, reports, manifests, artifacts, packets, and validation commands.

## Objective

Turn the latest master state into a stronger RAG house without dumping every artifact blindly.

The goal is to make `master` more usable as a trusted intake, retrieval, validation, and operator-control spine:

1. Keep `master` as the release/control plane.
2. Move or index docs into stable report/reference locations.
3. Keep code in runnable app/script locations.
4. Maintain provenance for every imported artifact.
5. Promote only validated assets into the flat RAG dollhouse.
6. Avoid destructive source-repo mutation.

## RAG House Target Shape

Use this structure as the consolidation target:

```text
apps/                         Runnable app surfaces
artifacts/                    Print/share PDFs and release artifacts
assets/                       Copied literal RAG assets when approved
data/                         Runtime state, cache, and structured inputs
docs/                         Operating doctrine and durable procedures
manifests/                    Indexes, maps, validation receipts, release lanes
references/                   Flat RAG house files and canonical reference bundles
reports/                      Human-readable plans, readiness tests, audits
scripts/                      Local validation and launch commands
skills/                       Agent/operator skills
surfaces/                     Static operator surfaces and cockpits
school-packets/               Packaged education/art packets
```

## Immediate File Movement Rules

Do not move everything at once. Use staged promotions:

### Promote into `references/`

Use `references/` for flat, retrieval-ready source packs:

```text
references/LANTERN-OS-RAG-DOLLHOUSE.flat.md
references/<topic>.flat.md
```

Candidates:

- Whitepaper summaries and durable doctrine.
- Cross-repo maps that agents need during retrieval.
- Canonical product, app, and skill inventories.
- Operator rules that should be indexed as plain text.

### Promote into `reports/`

Use `reports/` for dated, human-readable state:

```text
reports/V1-READINESS-TEST-2026-05-26.md
reports/LANTERN-OS-MASTER-PUSH-RAG-HOUSE-PLAN-2026-05-26.md
reports/<dated-audit-or-plan>.md
```

Candidates:

- Readiness checks.
- Cash sprint plans.
- Master push summaries.
- Product universe scans.
- Validation and risk reports.

### Promote into `manifests/`

Use `manifests/` for machine-readable or semi-structured indexes:

```text
manifests/STORE-RELEASE-LANES.md
manifests/validation/*.json
manifests/*-repos.md
manifests/*-assets.md
```

Candidates:

- Repo maps.
- Asset inventories.
- Validation receipts.
- Release lane status.
- External intake state maps.

### Keep code in runnable locations

Code should not be converted into prose-only RAG content. Keep it executable and only summarize/index it into references:

```text
apps/lantern-garage/
scripts/*.ps1
surfaces/*/
skills/*/SKILL.md
```

## RAG Intake State Model

Every source should receive one clear intake state:

```text
local_inspected
local_asset_copied
github_metadata_only
external_llm_summary
external_search_snippet
not_yet_cloned
held
```

Do not claim a source is cloned or validated unless it was actually inspected. Do not import dirty source state blindly. Do not move queue tasks or mutate source repos while building the dollhouse.

## Master Push Plan

### Phase 1: Stabilize the map

Create or update these index files:

```text
manifests/RAG-HOUSE-CONTENT-MAP.md
manifests/RAG-HOUSE-ASSET-INTAKE.md
manifests/RAG-HOUSE-CODE-SURFACES.md
```

Each entry should include:

- Path.
- Type: code, doc, report, asset, manifest, skill, surface.
- Intake state.
- Validation command or evidence.
- Promotion decision: promote, hold, reject, archive.

### Phase 2: Normalize docs

Move durable docs into:

```text
docs/
references/
reports/
```

Rules:

- Doctrine and operating procedures go to `docs/`.
- Retrieval-ready flat packs go to `references/`.
- Dated summaries and audits go to `reports/`.

### Phase 3: Preserve code behavior

Before code movement:

1. Capture current file path.
2. Capture launch/test command.
3. Move only one code surface at a time.
4. Update imports, script paths, and README commands.
5. Run the smallest validation command.
6. Commit with one clear message.

Recommended commit pattern:

```text
chore: map rag house content
chore: promote docs into rag house
chore: index code surfaces for rag retrieval
chore: refresh rag asset manifest
```

### Phase 4: Rebuild flat RAG file

After mapping and promotions, rebuild:

```text
references/LANTERN-OS-RAG-DOLLHOUSE.flat.md
assets/ASSET-MANIFEST.sha256
```

The flat file should contain:

- Repo identity.
- Current release rule.
- Active surfaces.
- Skills inventory.
- Reports inventory.
- Manifest inventory.
- Asset manifest reference.
- Open holds and risks.
- Validation receipts.

### Phase 5: Validate

Minimum validation checklist:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LanternConvergenceLoop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternLocalControls.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternGarageApp.ps1
```

Manual validation:

```text
http://127.0.0.1:4177
```

Check that:

- README commands still point to real paths.
- Validation receipts update cleanly.
- RAG flat file references real files only.
- No local-only absolute paths are promoted as portable artifacts without labels.
- No generated dump bypasses the convergence loop.

## Risks

1. Binary/PDF assets may bloat the repo if copied without selection.
2. Local Windows paths may not be portable.
3. App paths can break if code is moved before script updates.
4. External LLM/web material must be summarized with source metadata, not pasted wholesale.
5. Validation receipts can become stale quickly and must be refreshed after each major movement.

## Done Definition

This master plan is complete when:

- `reports/LANTERN-OS-MASTER-PUSH-RAG-HOUSE-PLAN-2026-05-26.md` exists on `master`.
- `README.md` links to this report.
- Future RAG-house movement follows the staged promote/hold/reject workflow.
- The flat RAG dollhouse is rebuilt only after source state and artifact rights are known.

## Next Safe Action

Create `manifests/RAG-HOUSE-CONTENT-MAP.md` and fill it from the current repo tree before moving any code or docs.
