---
name: lantern-rag-dollhouse
description: Build and use the single flat Lantern OS RAG dollhouse from local repos, GitHub repo metadata, literal COMET LEAP PDFs, 30-day art images, charts, convergence manifests, and future intake rules. Use when Codex needs a flat RAG-ready file, literal PDF/image assets in a skill, cross-repo Lantern/COMET LEAP consolidation, or a mass-clone/intake plan.
---

# Lantern RAG Dollhouse

Use this skill from `C:\tmp\lantern-os` when the user asks for one flat local
RAG file, all literal COMET LEAP PDFs/images, or cross-repo dollhouse intake.

## Core Files

- Flat RAG file: `references/LANTERN-OS-RAG-DOLLHOUSE.flat.md`
- Asset manifest: `assets/ASSET-MANIFEST.sha256`
- PDFs: `assets/pdfs/`
- 30-day art images: `assets/images/comet-leap-30day/`
- Charts: `assets/images/charts/`

## Intake Rule

Separate every source into one of these states:

- `local_inspected`: exists on disk and git/read-only state was checked.
- `local_asset_copied`: literal artifact copied into this skill.
- `github_metadata_only`: repo exists on GitHub but has not been cloned into
  the local dollhouse yet.
- `not_yet_cloned`: named repo absent from local disk.
- `held`: needs operator approval, credentials, hardware, or destructive action.

Use `skills/bayesian-world-model/SKILL.md` to turn these states into priors,
evidence classes, posteriors, and promote/hold/reject decisions.

## Update Loop

1. Inspect `git status --short --branch`.
2. Inspect local repos read-only.
3. Copy only selected literal assets into `assets/`.
4. Rebuild `assets/ASSET-MANIFEST.sha256`.
5. Update `references/LANTERN-OS-RAG-DOLLHOUSE.flat.md`.
6. Validate skill and artifact counts.
7. Commit and push.

## Boundaries

Do not pretend metadata-only repos have been cloned. Do not mutate source repos
while building the dollhouse. Do not import dirty source state blindly.
