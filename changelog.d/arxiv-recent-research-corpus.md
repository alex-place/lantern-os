feat(memory): local arXiv corpus so chat answers AI/LLM questions with post-cutoff research

Adds a local, always-current corpus of recent AI/LLM papers (abstracts + metadata,
categories cs.CL/cs.LG/cs.AI/cs.NE/stat.ML, submission month 2025-07 onward) on drive F:
(`ARXIV_CORPUS_DIR`, default `F:\arxiv-corpus`), and retrieves from it to ground the chat
assistant on research published *after* the model's training cutoff — each paper cited by
arXiv id. Strengthens the Remember stage.

- `scripts/arxiv_harvest.py` — OAI-PMH harvester (arXiv's sanctioned bulk route), `--backfill`
  and `--delta` modes, flow-control/Retry-After aware, deduped monthly JSONL shards. Dates
  papers by their **arXiv id** (`YYMM.NNNNN`), not the unreliable OAI `<created>` field (which
  returns e.g. 2026-05-29 for a 2017 paper because the datestamp window surfaces re-touched
  old papers).
- `scripts/arxiv_build_index.py` — builds a compact BM25 index (postings + doc store + meta).
- `apps/lantern-garage/lib/arxiv-index.js` — `queryArxiv()`: BM25 top-k with an AI-research
  keyword gate, cached index load, fail-safe `[]` on any error (never blocks chat). Mirrors the
  existing `queryResearchLibrary()` seam.
- Wired into `formatCSFContextForPrompt()` as a "Recent AI research (arXiv…)" section, gated
  behind `KEYSTONE_ARXIV_RETRIEVAL=1` (OFF until the corpus is built). Prompt framing forbids
  inventing or altering arXiv ids.
- `scripts/Register-ArxivHarvest.ps1` — daily scheduled delta + reindex.
- Docs: `docs/ARXIV-CORPUS.md`; tests: `tests/test_arxiv_harvest.py` (7),
  `apps/lantern-garage/test/arxiv-index.test.js` (7).

No new chat tool, no full-text/PDF/S3 (deferred). One doc source, not a parallel memory system.
