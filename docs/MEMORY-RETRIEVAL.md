# How Keystone Remembers — The CSF Memory & Retrieval System

This is the **Remember** stage of the Keystone loop (*Observe → Remember → Reason
→ Act → Verify → Converge*). It is one append-only, local-first memory — not a
pile of databases. This article explains how memories are written, how they are
recalled, how recall is ranked, and how the store stays fast as it grows forever.

> **One memory rule.** There is exactly one memory system: append-only JSONL
> registries plus the CSF archive. Nothing is mutated or deleted; confidence
> shifts and records are superseded, but history is preserved
> ([ADR-0004 · Append-only memory](/repo/docs/adr/0004-append-only-memory.md)).

## The shape of a memory

Every memory is a human-readable JSON **record** with full lineage. The canonical
engine is [`src/csf/memory_engine.py`](/repo/src/csf/memory_engine.py); the
runtime JS writer that backs the chat surfaces is
[`apps/lantern-garage/lib/csf-memory-writer.js`](/repo/apps/lantern-garage/lib/csf-memory-writer.js).
Both write the **same on-disk schema** under `data/csf_memory/`.

A record carries: a tier, content, a confidence score (0–1), a privacy scope, a
promotion chain (lineage), keywords + entities for retrieval, and a SHA-256
checksum over its canonical JSON.

### Tiers (how raw experience crystallizes)

```
trace → correction → anchor → entity → relation → ritual → skill → procedural → export
```

A **trace** is raw interaction. As patterns repeat and get attested, traces are
promoted toward **entities** (world model), **rituals/skills** (reusable
capability), and eventually **export** (cleared for release). This taxonomy is a
superset of the layers used by comparable open systems (e.g. MemOS's *L1 Traces →
L2 Policies → L3 World Model → Crystallized Skills*), with explicit
promotion-chain lineage so every higher-tier memory points back to its evidence.

### Cube partitions & privacy

Records live in four partitions — `raw → refined → canon → archive` — and carry a
privacy scope (`private | internal | public | export_safe`). The store is
**local-first by design**: you own the files, the model is replaceable, and
nothing leaves the machine unless a record is explicitly export-safe.

## Writing a memory

`create_trace(text, …)` builds a raw trace. Two things matter for it to be
*findable* later:

- **Keywords are auto-derived from the text.** If a caller doesn't supply
  keywords, the engine extracts up to ~48 distinctive (non-stopword) tokens from
  the content. A memory with no keywords is invisible to keyword retrieval — so
  this default is what makes a trace recallable at all.
- **The write is append-only.** The record is written as its own JSON file and
  appended to a per-partition `*.jsonl` registry. An inverted keyword/entity
  index is updated in memory for fast lookup.

## Recalling a memory

Retrieval runs in two places that share the on-disk format:

1. **The canonical engine** (`MemoryEngine.query`) — used by Python services, the
   MCP server, and repo-learning. It pulls candidates from the inverted index,
   then ranks them.
2. **The live chat path** (`apps/lantern-garage/lib/csf-memory.js`
   `queryMemories` / `formatCSFContextForPromptAsync`) — recalls relevant past
   turns and memories into the prompt, with an optional semantic rerank.

### How candidates are found

A natural-language question rarely contains *every* token of the memory that
answers it, so candidate selection uses **match-any (union)**: a record matching
*any* salient query term is a candidate. Precise lookups can still require *all*
terms (intersection) when needed.

### How candidates are ranked (IDF-weighted)

Ranking weights each matched term by **inverse document frequency** — a match on
a rare, distinctive word (e.g. *"pomegranate"*) outranks a match on a word common
to the whole corpus (e.g. *"meeting"*). The live chat path applies the same
IDF-weighted ranking, then can re-rank the top candidates with real semantic
similarity (a local `nomic-embed` model) when available, falling back safely to
keyword scoring when it isn't.

Recall is deliberately **gated**: a memory must clear a relevance threshold and a
distinct-hit count before it is injected as context, so a single coincidental
word can't make the model "remember" something that isn't there.

## Staying fast forever

Because memory is append-only and unbounded, retrieval has to stay fast as the
store grows:

- The inverted **index is persisted as a cold-start cache**, not rewritten on
  every write. It is saved on a throttle (and on graceful `flush()`), so bulk
  ingestion is near-linear rather than quadratic.
- On startup the cache is **trusted only when it is provably current** — its
  recorded per-partition registry byte-sizes must match the live files. Because
  registries are append-only, a size match proves nothing was added since the
  last save; any mismatch triggers a full rebuild. A stale cache can therefore
  never silently hide recently-written memories.

## Evidence

Retrieval quality is measured, not asserted, against
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) — a standard long-term
memory benchmark — via `experiments/longmemeval_harness.py`. On the hard haystack
(~50 sessions / ~490 turns per question):

| ranking | recall@5 | MRR |
|---|---|---|
| keyword-coverage (baseline) | 0.43 | 0.30 |
| **IDF-weighted + broad indexing** | **0.81** | **0.58** |

The dominant lever was **indexing breadth** (indexing the whole turn, not just
its first few tokens); IDF ranking and union candidate selection then order the
results well. Numbers accrue to `data/longmemeval/runs.jsonl`.

## Related

- [ADR-0004 · Append-only memory](/repo/docs/adr/0004-append-only-memory.md) — why one append-only store
- [ADR-0003 · One canonical CSF module](/repo/docs/adr/0003-one-canonical-csf-module.md) — the single serialization format
- [CSF Format Specification](/repo/docs/CSF-FORMAT-SPECIFICATION.md) — the archive layer beneath memory
- [Architecture overview](/repo/docs/ARCHITECTURE.md) — where memory sits in the system
