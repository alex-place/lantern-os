---
author: Claude (Opus 4.8)
created: 2026-06-30
updated: 2026-06-30
status: Living — baseline record; re-run when the doc set drifts
loop_stage: Verify + Converge (grounds the Knowledge Center surface; not a new subsystem)
---

# Knowledge Center — Σ₀ Grounding Baseline (2026-06-30)

This is the baseline record for a full Σ₀-grounding pass over the Knowledge Center
document library. Every in-repo doc was audited against **today's understanding**
and either **kept** (with a verified description + status + grounding), **removed
from the surface** (archived/merged), or **deleted**. The machine-readable source
of truth is [`data/knowledge/doc-catalog.json`](../data/knowledge/doc-catalog.json);
the page renders from it via [`scripts/build_doc_library.js`](../scripts/build_doc_library.js).

## What changed

- **Every card is now grounded.** Each doc carries a one-line *verified*
  description (not a scraped first line), a **status** (Living / Reference / Draft /
  Historical / Superseded / Duplicate / Lore) and a **grounding** level (Grounded /
  Partial / Ungrounded / Aspirational), plus its date — rendered as a metadata
  footer with colour-coded dots and a legend.
- **The surface is curated, not exhaustive.** The library went from ~247 in-repo
  cards to **154 kept**; **96 stale/duplicate/one-off docs were dropped** from the
  Knowledge Center. Because the RAG grounding index is built by scraping the
  `/repo/*.md` cards on this page, dropping a stale card also **removes it from what
  Keystone grounds its answers on** — the index shrank to **156 curated docs**.
- **Root-cause bug fixed (grounding quality).** Most repo docs are CRLF, and the
  `^---\n` frontmatter strip in both `build_doc_library.js` and
  `scripts/build_knowledge_index.py` silently failed on `---\r\n`. That leaked YAML
  frontmatter (`author: …`, `Status: …`, `Date: …`) into card summaries **and into
  the grounding corpus as "(intro)" sections**. Both now normalise newlines on read.
- **De-duplicated.** The duplicate `ADR-0008` (two files, conflicting status) is
  reconciled to the fuller *Proposed* variant; the `0000-template.md` ADR template
  and the individual lore *door* fragments no longer appear as cards.
- **Larger panels.** Cards are column-layout, 340px min-width, 20px padding, with a
  min-height so the metadata footer aligns across the grid.

## Method

16 parallel Σ₀ auditor agents read all 251 in-repo docs (size-balanced batches) and
returned a structured verdict per doc, checked against a shared grounding brief
(current provider reality, the refuted "we're ahead" frontier claims, the one-loop
North Star, Keystone/unisona.ai branding, the local-coder and CSF/trader state).
Cross-batch conflicts (the duplicate ADR-0008, the template, inconsistent lore) were
reconciled by hand. Two docs created after the audit began (`AGENTS.md` as a card,
the weather-oracle research note) were catalogued directly.

## Numbers

| Bucket | Count |
|---|---|
| Audited (in-repo) | 251 |
| **Kept (surfaced + grounded)** | **154** |
| Archived (dropped from surface, file retained) | 91 |
| Merged into a canonical doc | 4 |
| Removed (empty template) | 1 |

Kept by grounding: **Grounded 75 · Partial 40 · Ungrounded 38 · Aspirational 1**.
Archived by status: Historical 66 · Superseded 5 · Draft 8 · Lore 9 · Duplicate 1 · Reference 2.

(Counts are against the current `master` doc set; a handful of docs that existed
only in a local working tree — e.g. an uncommitted `FRONTIER-DIRECTIONS` draft — are
excluded and will auto-surface as **Unreviewed** cards once committed.)

"Archived / removed" here means **removed from the Knowledge Center surface and the
grounding index** — the files remain in-repo and in git history (reversible; no
cross-links broken). The decision + reason for every doc lives in the catalog.

## Convergence record

- **Claim:** Every Knowledge Center doc is now either grounded with a verified
  description + status, or removed from the surface; the grounding index reflects
  only the curated set.
- **Evidence:** `data/knowledge/doc-catalog.json` (250 verdicts); regenerated
  `knowledgecenter.html` (154 in-repo + 34 external cards); rebuilt
  `data/knowledge/index.jsonl` (156 docs, 0 frontmatter-leak sections); archived
  docs (e.g. `docs/SITEMAP.md`, `docs/TRADER-PHASE2-PROGRESS.md`) verified absent
  from the index; kept docs (`docs/MEMORY-RETRIEVAL.md`) verified present; a11y
  audit passes; no console errors in preview.
- **Confidence:** High on the surface/index mechanics (verified end-to-end);
  Medium on individual keep/archive line-calls (agent judgement, reconcilable via
  the catalog).
- **Source:** 16-agent Σ₀ audit + manual reconciliation + local preview verification.

## Re-running

```bash
node scripts/build_doc_library.js          # regenerate cards from the catalog
python scripts/build_knowledge_index.py    # rebuild the grounding index
```

New docs appear as **Unreviewed** cards (fallback extraction) until added to the
catalog with a verified description + status.
