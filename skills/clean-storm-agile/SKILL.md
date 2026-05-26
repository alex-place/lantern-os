---
name: clean-storm-agile
description: Lightning-fast Clean Storm agile sprint method for Lantern OS. Use when Codex needs to hammer the repo, trim fat, run repeated 12-step convergence loops, fix the first 2-4 issues, batch validate, reduce duplication, and push a clean sprint result without waiting at skeletons.
---

# Clean Storm Agile

Use this skill from `C:\tmp\lantern-os` when the operator asks to hammer
everything, trim fat, or run a lightning sprint.

## The 12 Lightning Steps

1. **Status:** inspect branch and dirty state.
2. **Fetch:** compare local branch to `origin/master`.
3. **Scan:** search for stale, fake, placeholder, TODO, broken-link, and old
   claim candidates.
4. **Sort:** choose the first 2-4 actionable issues.
5. **Strike:** fix those issues only.
6. **Trim:** remove duplicate wording, fake placeholders, stale workflow logic,
   and dead references.
7. **Tighten:** keep boundary notes only when they protect real action.
8. **Bayes:** update priors/posteriors for important claims.
9. **Validate:** run the cheapest relevant checks.
10. **Re-scan:** confirm the fixed issues are gone.
11. **Record:** update manifests or belief ledger.
12. **Ship/Repeat:** stage, commit, push, then start clean.

## Trim Rules

Cut fake examples that look real, stale remote/release claims, duplicate method
text when a skill owns it, mismatched workflow templates, and generated clutter
without a manifest.

Keep literal assets intentionally copied into a skill, held boundaries for
disks/bootloaders/phone boot/release approval/public-media rights, source
provenance, hashes, repo URLs, and evidence classes.

## Validation Pack

```powershell
git status --short --branch
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LanternConvergenceLoop.ps1
python C:\Users\alexp\.codex\skills\.system\skill-creator\scripts\quick_validate.py .\skills\clean-storm-agile
python C:\Users\alexp\.codex\skills\.system\skill-creator\scripts\quick_validate.py .\skills\bayesian-world-model
git diff --check -- README.md docs manifests scripts skills .github
```
