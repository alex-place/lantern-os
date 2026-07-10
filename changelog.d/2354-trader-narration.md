feat(memory): NL-gloss trading events so trader history is retrievable in dream-chat (#2354)

dream-chat and the trader share ONE CSF memory store (`data/csf_memory/raw.jsonl`),
but trading events were persisted as serialized JSON blobs with no `content.text`.
The shared recall path (`csf-memory.js::queryMemories` scores `content.text`; the
semantic reranker embeds it) therefore saw only bare tags — the trader's own
orders/signals/news were effectively unretrievable in chat (only reachable via
`queryRecentTradingRecords`, which is recency, not relevance), and the blobs
shadowed prose memory (see the readLifeFacts scan-from-end note in csf-memory.js).
Deep-research + our prior measurement: BM25 AND embeddings are near-noise on JSON
blobs (~0.08-0.11 recall) vs 0.91-0.98 on prose — so no reranker/embedder change
fixes this; the fix is to make each event retrievable prose.

- `trading-memory.js`: `_narrateOrder` / `_narrateSignal` emit a one-line,
  dependency-free, null-safe NL gloss; written to `content.text` on every order
  and signal CSF record.
- `trading-news.js`: `_narrateNews` does the same for news entities (direction +
  headline + source + impact).
- Narrations are relevance-gated by the existing recall threshold: they surface
  when a chat query overlaps, stay quiet otherwise (no shadowing).
- Backfill: existing blob records stay read-only; narration applies going forward.
- Tests: `test/trading-narration.test.js` — unit (field-accurate, null-safe) +
  end-to-end (a narrated order surfaces on a relevant query through the real
  `queryMemories` path; an off-topic query does NOT, proving the gate holds).
  CSF checksum integrity unchanged (`tests/test_csf_memory_integrity.py` green).

First of three from the retrieval-SOTA research pass (#2355 local cross-encoder
rerank, #2356 our-corpus measurement harness). Loop stage: Remember.
