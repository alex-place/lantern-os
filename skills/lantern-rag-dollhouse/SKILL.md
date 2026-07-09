---
name: lantern-rag-dollhouse
description: Build and use the single flat Lantern OS RAG dollhouse from local repos, GitHub repo metadata, literal COMET LEAP PDFs, 30-day art images, charts, convergence manifests, and future intake rules. Use when Codex needs a flat RAG-ready file, literal PDF/image assets in a skill, cross-repo Lantern/COMET LEAP consolidation, or a mass-clone/intake plan.
---

# Lantern RAG Dollhouse

Use this skill from `C:\tmp\lantern-os` when the user asks for one flat local
RAG file, all literal COMET LEAP PDFs/images, or cross-repo dollhouse intake.

## Core Files

- Flat RAG file: `references/LANTERN-OS-RAG-DOLLHOUSE.flat.md` (gitignored,
  machine-generated — rebuild with `npm run regen:rag` / `make regen-rag`; see
  issue #2313)
- Asset manifest: `assets/ASSET-MANIFEST.sha256`
- PDFs: `assets/pdfs/`
- COMET LEAPER operating narrative: `assets/pdfs/COMET-LEAPER-OPERATING-NARRATIVE-v1.pdf`
- 30-day art images: `assets/images/comet-leap-30day/`
- Charts: `assets/images/charts/`

## Intake Rule

Separate every source into one of these states:

- `local_inspected`: exists on disk and git/read-only state was checked.
- `local_asset_copied`: literal artifact copied into this skill.
- `github_metadata_only`: repo exists on GitHub but has not been cloned into
  the local dollhouse yet.
- `external_llm_summary`: compressed research from another LLM, not raw source.
- `external_search_snippet`: search result snippet or brief web finding.
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

## External LLM / Web Cache

When caching Googled information from another LLM, use:

```text
data/rag-intake/external-llm-web-cache/
scripts/Add-ExternalRagCacheItem.ps1
```

Store compressed claims, source URLs, dates, rights state, evidence class, and
confidence. Do not store raw article dumps or long copyrighted passages.

## Purge Lane (post-ingestion)

After `Sync-RagAndPdf.ps1` ingests markdown into the flat RAG file, the
derived PDFs in `reports/PDF/` become re-generatable and can be aged out.
Run `scripts/Invoke-PostIngestionPurge.ps1` (batch job `post-ingestion-purge`,
interval 245 min, `runAfter: sync-rag-pdf`) to enforce:

| Target | Rule |
|--------|------|
| `reports/PDF/*.pdf` | Delete if older than 7 days (re-derivable from markdown) |
| `manifests/evidence/*.json/.md` | Keep newest 30 per class prefix, drop the rest |
| `data/kalshi/*-2026-*-*.json` | Delete dated snapshots older than 7 days (superseded by `-latest.json`) |

Status Cube row (purge lane):

| `x` | `y` | `z` | `t` |
|-----|-----|-----|-----|
| `reports/PDF/`, `manifests/evidence/`, `data/kalshi/` | purge lane | re-derivable only; never purge source markdown or `-latest.json` | receipt written to `manifests/evidence/purge-{stamp}.json` |

## Boundaries

Do not pretend metadata-only repos have been cloned. Do not mutate source repos
while building the dollhouse. Do not import dirty source state blindly.
Do not purge source markdown — only derived PDFs and superseded snapshots.
