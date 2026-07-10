feat(eval): retrieval A/B measurement harness on our own corpus (#2356)

Gate the reranker decision (#2355) in evidence, not borrowed numbers. The
deep-research verdict (+17.2pp MRR@3 from cross-encoder reranking) is one financial
domain with a cloud reranker; per the External Reality Rule we measure a LOCAL
analog on OUR corpus before wiring anything.

- `scripts/eval_retrieval_ab.js`: arXiv-2604.01733-style ablation over a known-item
  eval set, reusing the REAL production scorers (`csf-memory.relevanceScoreIdf` +
  `buildDocFreq`; `semantic-reranker` nomic transport, now exporting `embedText`).
- Arms: `lexical-idf` + `bm25-okapi` (deterministic, always run); `nomic-dense` +
  `hybrid-a<α>` (iff Ollama up); `hybrid+rerank` (skipped-and-logged until #2355's
  `$RERANKER_ENDPOINT` exists). No silent caps — every skipped arm prints why.
- Metrics: Recall@{5,10}, MRR@{3,10}, overall + per lexical-overlap band. Honest
  ranking: non-positive score ≠ hit (Infinity), ties pessimistic — so an all-zero
  lexical arm can't score a false Recall@5 from a doc's corpus position.
- Fixture (18 docs / 15 queries incl. trading narrations, CI-safe): lexical-idf R@5
  0.867 overall, 0.333 on the low-overlap band vs 1.000 verbatim — isolates the band
  where dense/rerank must pay.
- `docs/BENCHMARKS.md`: 🟡 Partial row. Runs append to `data/eval/retrieval/runs.jsonl`
  (git-ignored). Tests: `test/eval-retrieval-ab.test.js` (11 checks, green).

Loop stage: Verify. Follows #2354 (trader narration), gates #2355 (rerank).
