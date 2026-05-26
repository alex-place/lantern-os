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
