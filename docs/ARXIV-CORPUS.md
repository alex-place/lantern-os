# arXiv Recent-Research Corpus

**Loop stage:** Remember. Gives the chat assistant a local, always-current body of
**post-cutoff** AI/LLM research so it can answer model/LLM questions with papers published
*after* the model's training cutoff — and cite them by arXiv id.

This is **one new doc source**, not a new memory system. It reuses the existing chat-context
assembler (`formatCSFContextForPrompt` in `apps/lantern-garage/lib/csf-memory.js`) exactly like
the "Research library:" seam, and every surfaced paper carries `[claim → evidence = arXiv id →
source = arXiv url]`.

## What it stores

- **Metadata + abstracts only** — no PDFs, no full text. ~1 GB for all 2025-07→ AI papers.
- Categories: `cs.CL`, `cs.LG`, `cs.AI`, `cs.NE`, `stat.ML` (edit `TARGET_CATEGORIES` in
  `scripts/arxiv_harvest.py`).
- Window: submission month **2025-07 onward** (bridges the pre-cutoff gap + all of 2026).

## Where it lives

Root = `ARXIV_CORPUS_DIR` env (default `F:\arxiv-corpus`):

```
raw\<YYYY-MM>.jsonl   # append-only, one paper per line, deduped by arXiv id
index\postings.json    # BM25 inverted index {term: [[docId, tf], ...]}
index\docs.jsonl       # compact doc store: {id,title,published,primary_category,snippet,url,len}
index\meta.json        # {count, avgdl, k1, b, built_at}
state\harvest.json     # last-harvest datestamp for --delta runs
```

## Dating: use the id, not `<created>`

arXiv's OAI-PMH date window filters by *last-modified datestamp*, so old papers re-touched
recently leak in with misleading `<created>` values (observed: `1709.08894`, a 2017 paper, came
back with `created=2026-05-29`). We therefore derive the true submission month from the **arXiv
id** (`YYMM.NNNNN` → `2017-09`), which is authoritative. Papers whose id predates the 2007
scheme are excluded (out of scope for a recent-research corpus).

## Commands

```bash
# One-time backfill (runs ~30-60 min for the full 2025-07→ window; metadata only)
python scripts/arxiv_harvest.py --backfill --from 2025-07-01

# Smoke test (cap new records)
python scripts/arxiv_harvest.py --backfill --from 2025-07-01 --max 40

# Daily incremental (from last harvest datestamp, with 2-day overlap)
python scripts/arxiv_harvest.py --delta

# (Re)build the retrieval index after any harvest
python scripts/arxiv_build_index.py
```

> The sandboxed Bash tool has no network egress — run harvests from a real shell / PowerShell.

## Wiring it into chat

Retrieval is **gated OFF by default**. Once the corpus + index exist, enable it:

```
KEYSTONE_ARXIV_RETRIEVAL=1
```

Then `formatCSFContextForPrompt()` adds a **"Recent AI research (arXiv…)"** section for
AI/ML-flavoured questions only (a keyword gate in `lib/arxiv-index.js` keeps it off unrelated
chats). Retrieval is BM25 top-3 and fail-safe: any missing index or parse error returns `[]`,
so chat is never blocked.

## Staying current

`scripts/Register-ArxivHarvest.ps1` registers a hidden daily Windows task that runs
`arxiv_harvest.py --delta` then `arxiv_build_index.py`, logging to `F:\arxiv-corpus\logs\`.

## Tests

- `tests/test_arxiv_harvest.py` — OAI-PMH parse, id-based dating, category/date filter, sharding.
- `apps/lantern-garage/test/arxiv-index.test.js` — BM25 ranking, AI-question gate, citable ids.
