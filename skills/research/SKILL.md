---
name: research
description: One universal, Σ₀-grounded research capability — fan-out web search + local arXiv-corpus grounding (post-cutoff AI papers, cited by id) + on-demand full-paper fetch, run as persisted, resumable rounds (Observe→Reason→Verify→Converge). Powers chat `!research`, plain-language "research/investigate X", `!convergance` grounding, and autowork issue research. Use whenever the user wants something researched, looked into, grounded in current sources, or wants the actual text of a paper.
---

# Research

Status: production-ready (web + task engine); local arXiv grounding + full-text fetch landed on branch `claude/arxiv-corpus`
Scope: chat (`!research`, natural language), `!convergance` grounding, autowork issue research, and command-line paper lookup
Source: `apps/lantern-garage/lib/{research-task,wide-search,arxiv-index,arxiv-fulltext}.js`, CLI `scripts/arxiv_query.js`

## Simple Answer

One search answers one question. A research **task** keeps going — each round targets the gaps the last round left open — until nothing's left or a round ceiling hits, and it survives across chat turns and server restarts because it's a plain JSON file. There is **one** research engine, and it grounds on **two** source classes at once:

- **Web** — dependable keyless fan-out (MCP → DuckDuckGo → Wikipedia), escalating fidelity.
- **Local arXiv corpus** — ~100k post-cutoff AI/ML papers (abstracts + metadata, 2025-07 onward) on drive F:, retrieved by BM25 and cited by arXiv id. This is how the assistant answers AI-research questions with papers published *after* the model's training cutoff.

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
- Local grounding fires only on AI/ML questions (the `queryArxiv` keyword gate) — by design, since the corpus is AI-only. Non-AI research is web-only.
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

See also: `skills/convergence/SKILL.md` (the record-emission side this feeds), `apps/lantern-garage/lib/arxiv-index.js` (BM25 retrieval), `apps/lantern-garage/lib/arxiv-fulltext.js` (full abstract + report fetch), and memory [[arxiv-recent-research-corpus]] (corpus build/harvest/gotchas).
