feat(research): universal /research skill — web + local arXiv grounding + full-paper fetch

The one research engine (`wide-search.js`) now folds the local arXiv corpus
(~100k post-cutoff AI/ML papers on drive F:) into the same source pool as web
results: `queryArxiv()` hits are deduped by URL, tagged `via:"arxiv:<id>"`, and
pruned/cited/scored exactly like web sources. Because `!research`,
`!convergance`, and autowork all call `wideSearch()`, they inherit web+local
grounding with no extra wiring and no dependence on `KEYSTONE_ARXIV_RETRIEVAL`
(that flag still governs only the separate plain-chat context injection).
Self-gated to AI questions and fail-safe (missing corpus → web-only); if the web
is down but the corpus has hits, the round still answers locally. Knobs:
`WIDE_SEARCH_ARXIV=0` to disable, `WIDE_SEARCH_ARXIV_K` (default 4).

New `lib/arxiv-fulltext.js` covers "give me the actual report": `readAbstractFromRaw(id)`
(untruncated abstract from the raw shard, no network) and `fetchArxivFullText(id)`
(fetches `arxiv.org/html/<id>` → ar5iv fallback, strips to plain text; returns the
pdf_url when no HTML rendering exists). On-demand per paper, never auto-injected
into a round. CLI `scripts/arxiv_query.js` exposes search / `--full` / `--paper <id>`
/ `--json`, reusing the same libs with no server required. `skills/research/SKILL.md`
rewritten as the single universal, Σ₀-grounded research skill.

Improves the Remember + Verify stages (better grounding, external-reality citations).
Verified: `node --check` clean on all changed JS; CLI returned real papers + 32k
chars of full text from arXiv HTML; `wideSearch()` with web stubbed empty produced
a pool that was 4/4 arXiv-tagged and still synthesized.
