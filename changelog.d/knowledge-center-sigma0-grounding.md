### Knowledge Center — Σ₀ grounding pass: every doc graded, curated, and CRLF-fixed

The Documents library was a flat auto-generated wall of ~247 cards whose summaries were
mostly leaked YAML frontmatter (`author: Alex Place`, `Status: …`) — because the `^---\n`
frontmatter strip in `build_doc_library.js` **and** `scripts/build_knowledge_index.py`
silently failed on the repo's CRLF docs. That same bug had been indexing frontmatter into
the RAG grounding corpus as `(intro)` sections. Both now normalize newlines on read.

A 16-agent Σ₀ audit graded all 251 in-repo docs against today's understanding and wrote a
verified catalog (`data/knowledge/doc-catalog.json`) that is now the source of truth for the
surface. Each card carries a real one-line description plus a **status** (Living / Reference /
Draft / Historical / Superseded / Lore) and a **grounding** dot (Grounded / Partial /
Ungrounded / Aspirational), in a larger panel with a metadata footer + legend.

- **154 docs kept** (grounded + surfaced); **96 stale/duplicate/one-off docs dropped** from
  the Knowledge Center. Since the grounding index is scraped from this page's `/repo/*.md`
  cards, dropping a stale card also removes it from what Keystone grounds answers on — the
  index shrank from ~247 to **156 curated docs** (0 frontmatter-leak sections).
- Duplicate `ADR-0008` reconciled to the fuller *Proposed* variant; the `0000-template.md`
  ADR template and individual lore *door* fragments no longer appear as cards.
- `knowledgecenter.html` regenerates its whole grid from the catalog; PDF report cards adopt
  the same markup. Baseline recorded in `docs/KNOWLEDGE-CENTER-AUDIT-2026-06-30.md`.

Verified: a11y audit passes both themes, no console errors, filters/counts/grounding-search
work; archived docs confirmed absent from the index, kept docs present.
