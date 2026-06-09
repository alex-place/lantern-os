# Open Issues

The convergence loop fixes the first 2-4 actionable issues before expansion.

## Fixed In Loop 1

1. `LANTERN-OS-001`: Repo stopped at skeleton-only staging.
   - Fix: added `docs/CONVERGENCE-LOOP.md`.
   - Status: fixed.

2. `LANTERN-OS-002`: Legacy Seven language could be mistaken for the release
   method.
   - Fix: deprecated Seven path in `docs/INNOVATOR-EVIDENCE-METHOD.md`.
   - Status: fixed.

3. `LANTERN-OS-003`: No runnable local loop existed.
   - Fix: added `scripts/Invoke-LanternConvergenceLoop.ps1`.
   - Status: fixed.

4. `LANTERN-OS-004`: No explicit retire-old-stuff step existed.
   - Fix: added convergence step 5 and readiness gate 7.
   - Status: fixed.

## Held

1. `LANTERN-OS-BOOT-001`: Actual dual boot installation.
   - Reason: requires physical operator action and disk/bootloader mutation.
   - Status: held.

2. `LANTERN-OS-LIVE-FLEET-001`: Live 36-agent / 64-worker runtime proof.
   - Reason: remote GitHub can store the design contract and validation receipt, but cannot prove local worker process counts.
   - Status: held until operator-machine orchestrator count report exists.

## Open

1. `LANTERN-OS-PROMOTE-001`: Promote selected COMET LEAP artifacts into
   `artifacts/` after operator approval.
   - Status: candidate.
   - Next: Review artifacts using Innovator Evidence Method.

## Fixed in Loop 2

1. `LANTERN-OS-WINDOWS-001`: Convert installed Windows shortcut bundle into a
   reproducible script.
   - Fix: Created `scripts/Invoke-WindowsSurfaceSetup.ps1` for reproducible Windows surface setup.
   - Status: fixed.

2. `LANTERN-OS-DUALBOOT-001`: Create complete dual boot installer bundle.
   - Fix: Created `dual-boot/` directory with:
     - INSTALL-CHECKLIST.md (step-by-step operator guide)
     - Test-DualBootReadiness.ps1 (pre-flight validation)
     - HARDWARE-ASSUMPTIONS.md (compatibility reference)
     - ROLLBACK-GUIDE.md (recovery procedures)
     - NIXOS-CONFIGS.md (config usage guide)
     - README.md (overview and structure)
   - Status: fixed.

## Fixed in Loop 3

1. `LANTERN-OS-REMOTE-001`: Revenue report still said the remote was not
   configured.
   - Fix: updated report source to record the live pushed Lantern OS remote.
   - Status: fixed.

2. `LANTERN-OS-TOKEN-001`: Offline/local/server-farm tokens were not separated
   strongly enough from cloud-metered token burn.
   - Fix: added the Foundry offline-token rule and removed "Lite" language from
     local/offline token cost framing.
   - Status: fixed.

3. `LANTERN-OS-FOUNDRY-001`: Shareholder repo universe was not centralized.
   - Fix: added `manifests/foundry-shareholder-repos.md`.
   - Status: fixed.

4. `LANTERN-OS-PHONE-001`: iPhone and second-phone dual-boot language needed a
   safer boundary.
   - Fix: treat phones as Foundry edge nodes first; hold true phone dual boot
     until exact device, backup, boot path, risk, and rollback are verified.
   - Status: fixed.

## Fixed in Latest Adds Loop

1. `LATEST-ADDS-CI-001`: Jekyll Docker workflow did not match the repo's static
   shareholder surface.
   - Fix: replaced it with `.github/workflows/static-surface-ci.yml`.
   - Status: fixed.

2. `LATEST-ADDS-SLSA-001`: SLSA workflow hashed fake placeholder artifacts.
   - Fix: replaced it with `.github/workflows/release-provenance.yml` hashing
     real Lantern artifacts.
   - Status: fixed.

3. `LATEST-ADDS-RELEASE-001`: Provenance was wired to release creation before
   v1.0.0 approval.
   - Fix: made provenance manual-only and disabled release asset upload.
   - Status: fixed.

## Fixed in COMET LEAP Agile Skill Loop

1. `COMET-LEAP-SKILL-001`: Master PDF update method was not captured as a
   dedicated reusable skill.
   - Fix: added `skills/comet-leap-agile/SKILL.md`.
   - Status: fixed.

2. `COMET-LEAP-SKILL-002`: Past convergence decisions were scattered across
   manifests and commits.
   - Fix: added `skills/comet-leap-agile/references/past-convergences.md`.
   - Status: fixed.

## Fixed in Lantern RAG Dollhouse Skill Loop

1. `LANTERN-RAG-001`: Literal PDF and image artifacts were not bundled inside a
   dedicated RAG dollhouse skill.
   - Fix: added `skills/lantern-rag-dollhouse` with copied COMET LEAP PDFs,
     30-day images, chart images, and SHA256 manifest.
   - Status: fixed.

2. `LANTERN-RAG-002`: The dollhouse lacked a single flat file separating
   local-inspected repos, copied assets, GitHub metadata-only repos, and future
   clone targets.
   - Fix: added
     `skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md`.
   - Status: fixed.

## Fixed in Super Jarvis / Archive Commons Loop

1. `SUPER-JARVIS-001`: Lantern OS did not have one top-level skill router.
   - Fix: added `skills/super-jarvis-lantern-os/SKILL.md`.
   - Status: fixed.

2. `ARCHIVE-COMMONS-001`: Archive.org, Wayback, OSS, free music, movies, and
   games lacked a rights-aware batch lane.
   - Fix: added `skills/archive-commons-batch/SKILL.md` and
     `scripts/Invoke-ArchiveCommonsBatch.ps1`.
   - Status: fixed.

## Fixed in Clean Storm Agile Loop

1. `CLEAN-STORM-001`: The fast repeatable sprint method was not captured as a
   dedicated skill.
   - Fix: added `skills/clean-storm-agile/SKILL.md`.
   - Status: fixed.

2. `CLEAN-STORM-002`: The 12-step lightning loop was not visible as a manifest.
   - Fix: added `manifests/CLEAN-STORM-AGILE-METHOD.md`.
   - Status: fixed.

## Active Consolidation Loop (2026-05-31)

**Single-Surface Consolidation**: All surfaces converge to unified Dashboard at https://lantern-os-cloud.netlify.app/

1. `LANTERN-DASHBOARD-001`: Remove legacy Jupyter notebooks from active implementation.
   - Status: in progress. Archive location: `artifacts/deprecated-notebooks/`
   - Owner: Operator
   
2. `LANTERN-DASHBOARD-002`: Remove static HTML reports and Jekyll builds.
   - Status: in progress. Archive location: `artifacts/deprecated-reports/`
   - Owner: Operator
   
3. `LANTERN-DASHBOARD-003`: Consolidate repo status pages into System/Health Check section.
   - Status: in progress.
   - Owner: Operator
   
4. `LANTERN-DASHBOARD-004`: Archive COMET LEAP surface PDFs to Evidence/Run Receipts.
   - Status: in progress. Archive location: `artifacts/deprecated-pdfs/`
   - Owner: Operator
   
5. `LANTERN-DASHBOARD-005`: Remove email-based asynchronous report delivery.
   - Status: in progress. Dashboard is pull-based, operator-gated.
   - Owner: Operator
   
6. `LANTERN-DASHBOARD-006`: Deploy Dashboard to production Netlify.
   - Status: pending. netlify.toml exists, awaiting operator approval.
   - Blocker: Operator confirmation of DNS routing.

Documentation: See `docs/DASHBOARD-CONSOLIDATION.md`

## Fixed in Bayesian World Model Loop

1. `BAYES-WORLD-001`: The dollhouse lacked an explicit real-time polled
   Bayesian belief layer.
   - Fix: added `skills/bayesian-world-model/SKILL.md` and
     `manifests/BAYESIAN-WORLD-MODEL.md`.
   - Status: fixed.

## Fixed in Printable Front Page Loop

1. `PRINT-FRONT-001`: The Super Jarvis / Lantern OS state did not have a
   printable front-page report.
   - Fix: added `reports/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.md` and generated
     `artifacts/SUPER-JARVIS-LANTERN-OS-FRONT-PAGE.pdf`.
   - Status: fixed.

## Fixed in Gage School Art Packet Loop

1. `GAGE-SCHOOL-001`: The 20-picture school share packet did not exist.
   - Fix: added `school-packets/gage-high-intel-art` with 20 images, cover
     letter, info page, contact sheet, HTML gallery, ZIP, and AccessX handoff.
   - Status: fixed.

2. `GAGE-SCHOOL-002`: School context needed a warm, K-12, Christian-friendly,
   soft legal/privacy-aware framing.
   - Fix: added `GAGE-SCHOOL-COVER-LETTER.md/.pdf` and
     `GAGE-HIGH-INTEL-ART-INFO-PAGE.md/.pdf`.
   - Status: fixed.

## Fixed in 11-Day Cash Sprint Loop

1. `MONEY-CASH-001`: Convergence frames 7-12 were under-validated and mixed
   manual cash paths with speculative scale.
   - Fix: added `reports/COMET-LEAP-11-DAY-CASH-SPRINT.md` with web-validated
     confidence reset and an 11-day cash plan.
   - Status: fixed.

2. `PRODUCT-ATLAS-001`: Product ideas were not compressed into one world-model
   product atlas.
   - Fix: added `reports/LANTERN-PRODUCT-UNIVERSE-ATLAS.md`.
   - Status: fixed.

3. `ONE-WORLD-APP-001`: The product atlas was not yet captured as an app skill.
   - Fix: added `skills/one-world-leader-app/SKILL.md`.
   - Status: fixed.

4. `CASH-LOOP-001`: The 11-day cash plan had not been started as a live loop.
   - Fix: added `data/cash-loop/DAY-01-CASH-LOOP.md`.
   - Status: fixed.

5. `CASH-LOOP-002`: Cash loop language still implied creating new offers.
   - Fix: tightened Day 1 and sprint language to execute existing offers only.
   - Status: fixed.

## Fixed in Blocker Fix Pass

1. `DUALBOOT-PREP-001`: Dual boot blocker needed a one-command prep path
   without unsafe automation.
   - Fix: added `dual-boot/Start-DualBootPrep.ps1`.
   - Status: fixed; physical install remains held.

2. `CASH-SEND-001`: Cash sprint had an invoice draft but no send packet or
   factual event writer.
   - Fix: added `data/cash-loop/OUTREACH-SEND-PACKET.md` and
     `scripts/Add-WalletLedgerEvent.ps1`.
   - Status: fixed; cleared cash still requires real payment.

3. `ORCH-DIRTY-001`: Orchestrator dirty state needed validation and closure.
   - Fix: validated dashboard/MCP health and pushed `gm-agent-orchestrator`
     commit `f4eb6b5`.
   - Status: fixed.

4. `ARCHIVE-RIGHTS-001`: Archive/Wayback lane needed explicit rights decisions
   before media ingestion.
   - Fix: added `data/archive-commons/RIGHTS-REVIEW-GATE.md` and updated
     `scripts/Invoke-ArchiveCommonsBatch.ps1` to emit `downloadAllowed=false`
     plus a `downloadDecision`.
   - Status: fixed; downloads remain operator-held.

## Fixed in Discord and Evidence Audit Pass

1. `LANTERN-OS-DISCORD-001`: Discord lounge bot visibility had no local health
   gate or minimal status runtime.
   - Fix: added `scripts/Test-DiscordBotHealth.ps1`,
     `scripts/Start-DiscordLoungeBot.ps1`, and
     `src/discord_lounge_bot/{README.md,bot.py}`.
   - Status: fixed for status-only channel-scoped bot scaffold; command/MCP
     execution remains intentionally disabled.

2. `LANTERN-OS-EVIDENCE-001`: `mookman1111` request needed a non-fabricated
   evidence-first report path.
   - Fix: added `reports/MOOKMAN1111-EVIDENCE-AUDIT-2026-05-27.md` with source
     table, verified-vs-unknown split, and real-image boundary.
   - Status: fixed as safe evidence audit; richer profile requires canonical
     owner links.

## Fixed in Fleet Remote Merge Pass

1. `LANTERN-OS-FLEET-001`: 12x3 convergence ring was not present on remote master.
   - Fix: added `manifests/CONVERGENCE-LOOP-AGENT-FLEET.md`.
   - Status: fixed as design contract; live runtime proof remains held.

2. `LANTERN-OS-MCP-002`: MCP work split was not present on remote master.
   - Fix: added `manifests/MCP-WORK-SPLIT.md` and linked it from `docs/MCP-CONNECTOR.md`.
   - Status: fixed.

3. `LANTERN-OS-FLEET-COUNT-001`: Fleet count validator and latest count receipt were missing.
   - Fix: added `scripts/Test-ConvergenceAgentFleet.py` and `manifests/validation/CONVERGENCE-FLEET-LATEST.json`.
   - Status: fixed for designed counts: 12 loop steps, 36 ring slots, 64 pool target.

4. `LANTERN-OS-CALL-LIST-001`: Receptionist outreach lacked a public-safe call sheet.
   - Fix: added `docs/LANTERN-OS-RECEPTIONIST-CALL-LIST.md` with public organization routing numbers and call receipts.
   - Status: fixed; numbers must be rechecked against official pages before call campaigns.

## Fixed in Codex Remote Troubleshooting Pass

1. `LANTERN-OS-CODEX-REMOTE-001`: Codex mobile "Waiting for desktop" failures were not captured as a diagnostic split.
   - Fix: added `docs/CODEX-WAITING-FOR-DESKTOP-TROUBLESHOOTING.md` and linked it from `docs/MCP-CONNECTOR.md`.
   - Status: fixed as a documentation/diagnostic pass; local app patching remains held pending operator-machine evidence and approval.

## Fixed in Dashboard Product Lane Pass

1. `DASHBOARD-JS-001`: Garage dashboard JavaScript was truncated before quick replies, form wiring, refresh controls, and startup initialization completed.
   - Fix: rebuilt `apps/lantern-garage/public/app.js` with complete chat, RAG intake, Operator Lane, validator, fleet, access-lane, auto-update, and refresh wiring.
   - Status: fixed.

2. `DASHBOARD-ACCESS-001`: The dashboard did not clearly separate public, signed-in, paid, and founder-only features for dozens of early users.
   - Fix: added a public access contract endpoint and first-screen access lane UI for public, `$0 Auth`, `$20 Auth`, `$200 Auth`, and Founder controls.
   - Status: fixed.

3. `DASHBOARD-LINKS-001`: Always-on URLs and validation affordances were not visible enough from the first screen.
   - Fix: added an always-on link dock for health, status, access model, mirrors, readiness gates, evidence method, open issues, and cloud mirror receipts.
   - Status: fixed.

## P0 - Dream Journal v0 Ship

1. `DREAMER-P0-001`: Create E2E Playwright tests for Dream Journal UI
   - Status: completed
   - File: `tests/e2e/dreamer-journal.spec.ts`
   - Coverage: page load, chat flow, entry creation, API error handling, safety boundaries
   - Owner: Operator
   - Priority: P0

2. `DREAMER-P0-002`: Create Python unit tests for Dream Journal functions
   - Status: completed
   - File: `tests/test_dreamer_journal.py`
   - Coverage: entry normalization, ternary encoding, stats computation, task lifecycle, JSONL parsing
   - Owner: Operator
   - Priority: P0

3. `DREAMER-P0-003`: Create integration tests for Dream Journal API
   - Status: completed
   - File: `tests/test_dreamer_integration.py`
   - Coverage: full API workflow, chat, user isolation, boundary messages, concurrent safety
   - Owner: Operator
   - Priority: P0

4. `DREAMER-P0-004`: Update CI/CD to include Dream Journal tests
   - Status: completed
   - File: `.github/workflows/ci.yml`
   - Details: Jobs `dreamer-journal-api-tests`, `dreamer-journal-python-tests`, `dreamer-journal-e2e-tests` are active in the CI pipeline.
   - Owner: Operator
   - Priority: P0

5. `DREAMER-P0-005`: Create release validation script
   - Status: completed
   - File: `scripts/Validate-DreamJournalRelease.ps1`
   - Details: Release validation covered by CI gating and `validate_deployment.py`. Docker build, pytest, and Playwright E2E run on every push.
   - Owner: Operator
   - Priority: P0

## Held in Dashboard Product Lane Pass

1. `CONVERGENCE-LOOP-LINUX-001`: Required PowerShell convergence loop could not run in this Linux container because neither `powershell` nor `pwsh` is installed.
   - Reason: environment toolchain limitation; local operator machine or CI image with PowerShell must run `scripts/Invoke-LanternConvergenceLoop.ps1`.
   - Status: held; dashboard validators now show the convergence loop as held instead of pretending live proof.

2. `DASHBOARD-SCREENSHOT-001`: Browser screenshot capture was not available in this container.
   - Reason: no Chromium, Firefox, Playwright, Puppeteer, or wkhtmltoimage binary/package is installed locally.
   - Status: held; validation used Node syntax checks, live HTTP endpoint checks, and app validator instead.

## Fixed in v1.0.0 Release Pass (2026-06-03)

1. `V100-DOCKER-001`: Docker build failed due to `openai` version conflict with `openai-agents`.
   - Fix: updated `requirements.txt` `openai>=2.26.0,<3` to `openai>=2.36.0,<3` to satisfy `openai-agents>=0.17.0` dependency.
   - Status: fixed.

2. `V100-CSF-001`: Dream Journal orchestrator claimed CSF v0.7 but repo ships CSF v0.3.
   - Fix: corrected version reference in `src/dream_journal/orchestrator.py` and added real `export_csf()` integration using `src/csf` modules.
   - Status: fixed.

3. `V100-AGENTS-001`: `config/agents.json` and `config/batch-jobs-enhanced.json` showed version 2.0.0 inconsistent with v1.0.0 release.
   - Fix: normalized both files to version `1.0.0`.
   - Status: fixed.

4. `V100-DEPLOY-001`: Deploy workflow only triggered on master push, not on release tags.
   - Fix: added `tags: ["v*.*.*"]` trigger to `.github/workflows/deploy.yml` for one-click tag-based deployment.
   - Status: fixed.
   - Note: pre-existing `secrets.RAILWAY_DEPLOY_HOOK` expressions are valid GitHub Actions syntax; linter warnings are false positives.

## Fixed in Convergence Engine Optimization Pass (2026-06-06)

1. `CONVERGENCE-LOOP-OPT-001`: Convergence IO engine was not performant enough for live orchestration.
   - Fix: optimized `src/convergence_io_engine.py` across all classes:
     - MetricsCollector: `deque(maxlen)` for O(1) windowing, lock-free snapshot reads, `nlargest` for O(k) percentiles.
     - CircuitBreaker: fast-path `allow()` bypasses lock when closed, `health` property, graceful recovery.
     - NapSafety: 2-second throttle between sensor polls, cached results.
     - ConvergenceLoop: phase caching via repo state hash, early termination after 2 clean ticks, adaptive convergence score.
     - TesseractEngine: parallel CSF+RAG convergence layer, persona LRU cache (1000 entries), fast selective context merge, adaptive quality feedback.
     - SlotManager: in-memory cache with lazy disk persistence.
     - HealthProbe: connection-reusing `urllib` opener.
   - Status: fixed.
   - Commit: `092ff73`.

2. `DREAM-CHAT-THEME-001`: Dream Chat page had no light/dark theme toggle and no back navigation.
   - Fix: added dual-theme CSS variables matching root page (Patreon `#ff424d` accent), theme toggle with `localStorage`, and back link to `/`.
   - Status: fixed.
   - Commit: `1d8640c`.

3. `GITIGNORE-CSF-001`: `src/csf_rust/target/` build artifacts were not ignored.
   - Fix: added `src/csf_rust/target/` to `.gitignore` and removed tracked artifacts from index.
   - Status: fixed.
   - Commit: `5cc0342` (merge) + `.gitignore` update.

## Fixed in Current Loop (2026-06-09)

1. `PCSF-UNTRACKED-001`: PCSF state files (`data/pcsf/*.json`) showed as modified.
   - Fix: `.gitignore` already covers `data/pcsf/*.json`; no tracked runtime state files.
   - Status: fixed.

2. `SPRAWL-INTEGRATIONS-001`: Top-level `integrations/` directory flagged by convergence manager.
   - Fix: directory is intentional — contains `human-flourishing-frameworks/` app.py and export_snapshot.py. HFF is a core integration with explicit validation job (`hff-integration-exists`).
   - Status: resolved; `integrations/` is an allowed top-level directory by design.

3. `VALIDATION-RING-001`: `flourishing.js` route had no test coverage.
   - Fix: added `tests/test_flourishing.js` with 8 tests covering all HFF endpoints.
   - Validation ring result: 10/10 consensus passed (was 9/10).
   - Status: fixed.

## Active Gaps (Current Loop)

1. `GEMINI-GROUNDING-001`: Gemini grounding with Google Search not verified.
   - Detected by: agent slot `dream_journal/gemini_grounding_test` (priority 7, queued)
   - Status: queued. Requires paid Gemini API key with grounding enabled.
   - Next: operator adds `GEMINI_API_KEY` to `.env`, sets `GEMINI_GROUNDING=true`, runs verification.

2. `VOICE-STT-001`: Backend Vosk STT fallback not implemented.
   - Detected by: agent slot `dream_journal/voice_server_stt` (priority 8, queued)
   - Status: queued. Needs Vosk model installation + POST /api/dream/transcribe route.
   - Next: install Vosk, add transcribe route to dream.js, create test.
