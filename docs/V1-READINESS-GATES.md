---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# Keystone OS v1.0.0 Readiness Gates

v1.0.0 is not a date. It is a gate.

## Gate 1: Repo Cleanliness

- Source repos have reviewed dirty state.
- Promoted artifacts are copied intentionally.
- Generated blobs are not mixed with source without manifest entries.
- The first 2-4 convergence-loop issues are fixed or explicitly held.

## Gate 2: Windows Surface

- Feather Lantern icon exists.
- Desktop and Start Menu launchers exist.
- Main launchers open the expected targets.
- PDF and Buffett/COMET LEAP docs are visible from the operator surface.

## Gate 3: NixOS / Dual Boot

- NixOS configs are present and reviewed.
- Dual boot plan is documented.
- No unattended disk or bootloader mutation exists.
- Operator performs physical install steps.

## Gate 4: COMET LEAP 30-Day Model

- 30 day images are complete.
- Merged PDF validates as a PDF.
- Art model DOCX exists.
- Money/confidence and truth-only reports exist.
- Claims are reviewed with the Innovator method before promotion.

## Gate 5: Capability Honesty

- Every surface states what it can and cannot do.
- Local-first and privacy claims are evidence-backed.
- Runtime claims are verified against actual scripts or services.

## Gate 6: Release Approval

- Operator explicitly says: promote to v1.0.0.
- Release notes are written.
- Tag is created only after approval.

## Gate 7: Old Surface Retirement

- Deprecated validation language is marked retired.
- Skeleton-only docs are upgraded or removed.
- Old launch paths that conflict with Keystone OS are holdd.

## Gate 8: Loop Evidence

- Latest loop output is saved or summarized.
- Open issues have status.
- Fixed issues have validation evidence.

## Gate 9: Dream Works

- At least one end-to-end operator path exists:
  - open Windows surface;
  - inspect COMET LEAP artifact manifest;
  - inspect dual boot prep;
  - run convergence loop;
  - see next action.
