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

## Open

1. `LANTERN-OS-PROMOTE-001`: Promote selected COMET LEAP artifacts into
   `artifacts/` after operator approval.
   - Status: candidate.
   - Next: Review artifacts using Innovator Evidence Method.

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
