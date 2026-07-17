# arXiv Recent-Research Corpus

**Loop stage:** Remember. Gives the chat assistant a local, always-current body of
**post-cutoff** AI/LLM research so it can answer model/LLM questions with papers published
*after* the model's training cutoff — and cite them by arXiv id.

This is **one new doc source**, not a new memory system. It reuses the existing chat-context
assembler (`formatCSFContextForPrompt` in `apps/lantern-garage/lib/csf-memory.js`) exactly like
the "Research library:" seam, and every surfaced paper carries `[claim → evidence = arXiv id →
source = arXiv url]`.

## What it stores

- **Harvested papers: metadata + abstracts only** — no full text. ~1 GB for all 2025-07→ AI papers.
- Categories: `cs.CL`, `cs.LG`, `cs.AI`, `cs.NE`, `stat.ML` + q-fin.* (edit `TARGET_CATEGORIES` in
  `scripts/arxiv_harvest.py`).
- Window: submission month **2025-07 onward** (bridges the pre-cutoff gap + all of 2026).
- **Curated tranches are the exception** — hand-picked papers outside the harvest window/categories,
  added by id via `scripts/arxiv_add_papers.py`, often **with their PDFs** in `pdfs\<id>.pdf`
  (see "Curated tranches" below).

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

## Curated tranches (beyond the harvest window)

The harvester deliberately stays narrow (AI + q-fin, 2025-07→). For research fields we cite
deliberately — starting with **control engineering** (eess.SY / math.OC: event-triggered and
self-triggered control, the 15-year "schedule the next intervention from measured decay rates"
canon that grounds Verify-stage scheduling, rebalance bands, Q-exit early stopping, and
watcher/poller cadences) — papers are added **by id, curated and judged, not harvested**:

```bash
# Fetch authoritative metadata from the arXiv API, append to raw shards (deduped),
# download PDFs, rebuild the index — ids are the ONLY input (titles/abstracts always
# come from arXiv itself, never from the requester):
python scripts/arxiv_add_papers.py --ids 0806.0709,1301.2182 --pdfs --reindex
python scripts/arxiv_add_papers.py --file tranche.json --pdfs --reindex
```

Rules of the road:

- Modern **YYMM.NNNNN ids only** (pre-2007 ids can't be dated by id and are rejected).
- Records land in the same `raw\<YYYY-MM>.jsonl` shards under the same schema — one corpus,
  one index, no second memory system. Dedup is corpus-wide; re-running an add is a no-op.
- PDFs live at `pdfs\<id>.pdf`; each tranche leaves a `pdfs\REVIEW-<date>-<topic>.md` note
  recording what was added and the per-paper `[claim → evidence]` line it grounds.
- The daily harvest does **not** track curated categories — a tranche grows only when someone
  curates it again. That's intentional (anti-sprawl): eess.SY/math.OC as a firehose would
  double the corpus for a field we cite selectively.
- The chat gate (`AI_GATE_TERMS` in `lib/arxiv-index.js`) carries a small control-engineering
  term group so trigger-scheduling questions actually retrieve the tranche.

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

---

# The one research engine (`!research`) — absorbed from `skills/research/SKILL.md` (2026-07-16)

# Research

Status: production-ready (web + task engine); local arXiv grounding + full-text fetch landed on branch `claude/arxiv-corpus`
Scope: chat (`!research`, natural language), `!convergance` grounding, autowork issue research, and command-line paper lookup
Source: `apps/lantern-garage/lib/{research-task,wide-search,arxiv-index,arxiv-fulltext}.js`, CLI `scripts/arxiv_query.js`

## Simple Answer

One search answers one question. A research **task** keeps going — each round targets the gaps the last round left open — until nothing's left or a round ceiling hits, and it survives across chat turns and server restarts because it's a plain JSON file. There is **one** research engine, and it grounds on **two** source classes at once:

- **Web** — dependable keyless fan-out (MCP → DuckDuckGo → Wikipedia), escalating fidelity.
- **Local arXiv corpus** — ~115k post-cutoff papers (abstracts + metadata, 2025-07 onward) on drive F:, retrieved by BM25 and cited by arXiv id: the AI/ML core (cs.CL/LG/AI/NE, stat.ML) plus quantitative finance (q-fin.* — Sharpe/portfolio/trading-strategy research for the trading lane). This is how the assistant answers research questions with papers published *after* the model's training cutoff.

When you want the **actual report** (not just the abstract), the skill fetches the paper's full text on demand. This is the four-object `Task` (goal + status), scoped to research, improving the **Remember** and **Verify** stages of the loop — not a new memory system.

## What It Actually Does

- `createTask(topic, {sessionId})` — starts a task, persists `data/research-tasks/<id>.json`.
- `runRound(task, onStep)` — one round: build a query from the topic + open gaps → `wideSearch()` → merge new sources → gap-check for what's still missing. Saves after every round.
- **`wideSearch()`** (the per-round engine, `wide-search.js`) is where the two source classes blend:
  1. **Observe** — expand into angled sub-queries, fan them all out to the web, dedupe into one pool.
  2. **Observe (local)** — `queryArxiv(q, WIDE_SEARCH_ARXIV_K)` folds relevant local papers into the *same* pool, deduped by URL, tagged `via: "arxiv:<id>"`. Self-gated to AI-research questions (contributes nothing on non-AI topics) and fail-safe (missing corpus → `[]`, web research unaffected). If the web is down but the corpus has hits, the round still answers from local papers.
  3. **Reason (low → high)** — cheap model prunes the pool + drafts; stronger model synthesizes with inline `[n]` citations. arXiv sources are cited exactly like web sources.
  4. **Verify / Converge** — every kept source is numbered and returned; confidence falls out of pool survival + citation density.
- A task is `done` when the gap-check is empty or `MAX_TOTAL_ROUNDS` (default 8) hits.
- On completion, emits a Convergence Record with evidence (`evidence_ids` = source URLs / arXiv ids) and ingests a CSF memory entry.

### Three chat/agent entry points (one engine)
- **Chat**: `!research <topic>` / `!research continue <taskId>`, or plain language ("research X", "look into X", "investigate X") — runs up to `RESEARCH_ROUNDS_PER_TURN` (default 3) rounds per turn, streams every stage live, tells the user the resume command if not done.
- **`!convergance` grounding**: `handleConvergenceCommand` runs up to 2 bounded rounds to ground its claims, falling back to a single `webSearch()` on error.
- **Autowork issue research**: `researchIssue()` runs up to `AUTOWORK_RESEARCH_ROUNDS` (default 2) rounds instead of a single skim.

## Getting the actual report (full paper text)

The corpus stores abstracts only. When the user asks for the *actual paper* / full text / "read the whole thing", use `arxiv-fulltext.js` (also exposed on the CLI):

- `readAbstractFromRaw(id)` — the **full, untruncated abstract** + metadata (authors, categories, pdf_url), read locally from `raw\<YYYY-MM>.jsonl`. No network. (BM25 search only returns a 400-char snippet — use this when the snippet is cut off.)
- `fetchArxivFullText(id)` — the **actual report**: fetches arXiv's HTML rendering (`arxiv.org/html/<id>`, LaTeX-derived; `ar5iv.org` fallback), strips to plain text, caps at `ARXIV_FULLTEXT_MAX_CHARS` (default 60k). One paper at a time, on demand — never bulk, never auto-injected into a round (it would blow the context). If no HTML rendering exists, it returns the `pdf_url` so you can hand the user a direct link.

## Command line (no server needed)

`scripts/arxiv_query.js` reuses the exact same libs the chat assistant uses, reading the corpus on F: directly:

```bash
node scripts/arxiv_query.js "retrieval augmented generation hallucination"   # top-k metadata + abstract
node scripts/arxiv_query.js "long context attention" -k 8 --full             # untruncated abstracts
node scripts/arxiv_query.js "long context attention" -k 5 --json             # machine-readable
node scripts/arxiv_query.js --paper 2507.00002                               # fetch the ACTUAL report text
node scripts/arxiv_query.js --paper 2507.00002 --json                        # metadata + fulltext as JSON
```

Use the CLI when researching from Claude Code / an agent that can't hit the chat SSE endpoint. Use the chat `!research` flow when you want the full multi-round, gap-driven, web+local task.

## Evidence / Source Discipline (Σ₀)

- Every claim in a final answer is expected to cite a numbered source `[n]`; the task JSON keeps the full source list (title, url/arXiv id, snippet, which sub-query found it) for audit.
- arXiv sources are **local and citable** — an arXiv id is a stronger anchor than a web snippet. Prefer citing the paper id when a claim comes from the corpus.
- Confidence is **not** invented by the model: `_confidence()` derives it from pool coverage (kept/pooled) and citation density (how many `[n]` refs actually appear). Never assert `verified` above the evidence.
- Date papers by **arXiv id** (`YYMM.NNNNN`), not the OAI `<created>` field — see [[arxiv-recent-research-corpus]] for why `<created>` is unreliable.

## Proven / Held / Local-Only

**Proven (this branch, verified runs):**
- CLI search returns real post-cutoff papers with abstracts; `--full` hydrates the untruncated abstract from raw; `--paper` fetches 32k chars of clean full text from `arxiv.org/html`.
- `wideSearch()` folds local arXiv into the pool (verified with web stubbed empty: 4/4 pool sources were arXiv-tagged, and the round still synthesized) — so `!research`, `!convergance`, and autowork all inherit local grounding with no extra wiring.
- `node --check` clean on `arxiv-fulltext.js`, `wide-search.js`, `arxiv_query.js`.

**Held / knobs:**
- Local grounding fires only on AI/ML or quant-finance questions (the `queryArxiv` keyword gate) — by design, matching the corpus categories. Other topics are web-only.
- `WIDE_SEARCH_ARXIV=0` disables local grounding; `WIDE_SEARCH_ARXIV_K` (default 4) sets how many papers to fold in.
- Full-text fetch needs network egress and only works for papers with an arXiv HTML rendering (most 2023+); otherwise you get the PDF link, not extracted text.
- The plain-chat context injection (`csf-memory.js`, gated `KEYSTONE_ARXIV_RETRIEVAL=1`) is a *separate, lighter* path that drops top-3 papers into the prompt for ordinary chat turns — the research engine's grounding here is independent of that flag.

**Local-only boundary:**
- Corpus + index live entirely under `ARXIV_CORPUS_DIR` (default `F:\arxiv-corpus`), refreshed by the daily `KeystoneArxivHarvest` task. Task state is `data/research-tasks/*.json`. The only network calls are the existing web-search chain and (on explicit request) the arXiv full-text fetch.

## Validation Path

- `node --check apps/lantern-garage/lib/{research-task,wide-search,arxiv-index,arxiv-fulltext}.js scripts/arxiv_query.js`
- CLI: `node scripts/arxiv_query.js "<AI topic>"` → confirm citable papers; `--paper <id>` → confirm full text or an honest PDF-link fallback.
- Engine: stub `web-search-client` to return `[]`, run `wideSearch({query:"<AI topic>"})`, assert `out.sources` contains `via: "arxiv:*"` entries.
- Chat: dev preview, `!research <AI topic>`, confirm an `observe/local_arxiv` step streams and arXiv ids appear in the cited sources.
- Future: node:test coverage exercising `runRound()` with a mocked `wideSearch()` and a mocked corpus so the round-loop + local-merge are covered without live network.

## Appendix: Task Schema

```json
{
  "id": "topic-slug-<base36-timestamp>",
  "topic": "the original topic string",
  "sessionId": "chat session id or autowork-issue-<n>",
  "status": "running | done",
  "rounds": [ { "n": 1, "query": "...", "answerPreview": "...", "sourcesFound": 8, "confidence": 0.5, "gaps": ["..."], "at": "ISO" } ],
  "sources": [ { "n": 1, "title": "...", "url": "...", "snippet": "...", "via": ["subquery or arxiv:<id>"] } ],
  "latestAnswer": "the most recent round's synthesized answer",
  "confidence": 0.61,
  "gaps": ["what the last round's gap-check flagged"],
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

See also: `docs/CONVERGENCE-LOOP.md` (the `!convergance` record-emission side this feeds), `apps/lantern-garage/lib/arxiv-index.js` (BM25 retrieval), `apps/lantern-garage/lib/arxiv-fulltext.js` (full abstract + report fetch), and memory [[arxiv-recent-research-corpus]] (corpus build/harvest/gotchas).
