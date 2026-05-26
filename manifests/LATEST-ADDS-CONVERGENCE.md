# Latest Adds Convergence

Generated: 2026-05-26.

Status: remote workflow adds reviewed and converged.

## Latest Adds From GitHub

| Commit | Added | Initial State | Convergence Action |
|---|---|---|---|
| `81f676d` | `.github/workflows/generator-generic-ossf-slsa3-publish.yml` | Placeholder SLSA workflow hashing fake `artifact1` and `artifact2`; release trigger could run before v1 approval | Replaced with manual `release-provenance.yml` hashing real Lantern artifacts only |
| `62d052b` | `.github/workflows/jekyll-docker.yml` | Docker/Jekyll build using `jekyll/builder:latest` and broad `chmod 777`; repo has static HTML, not Jekyll | Replaced with `static-surface-ci.yml` validating real static surface files and links |

## Fixed Issues

1. `LATEST-ADDS-CI-001`: Jekyll workflow did not match the repo.
   - Fixed by replacing it with static surface validation.

2. `LATEST-ADDS-SLSA-001`: SLSA workflow used fake artifacts.
   - Fixed by hashing actual report, PDF, and matrix artifacts.

3. `LATEST-ADDS-RELEASE-001`: Release-triggered provenance could imply release
   readiness before operator approval.
   - Fixed by making provenance manual-only and disabling release asset upload.

## Validation Path

- Run repository convergence loop.
- Check workflow YAML names and paths.
- Check static HTML links against local files.
- Keep v1.0.0 release creation held until operator says ready.
