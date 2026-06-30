# Memory Recall Benchmark (LongMemEval) — methodology + how to run

Durable, re-runnable harness that measures Keystone's **live** memory retrieval
against the **LongMemEval** task, and wires a head-to-head against external
memory systems (Letta/MemGPT, Mem0, Zep). Closes the "we assert a memory edge we
never measured" gap (#1739) — the prior `runs.jsonl` referenced a harness that was
never committed.

## Why it's trustworthy

It benchmarks the **actual scoring code we ship** — `relevanceScore`,
`relevanceScoreIdf` + `buildDocFreq` from `apps/lantern-garage/lib/csf-memory.js`
— not a re-implementation. Recall@k is **retrieval-only**: no LLM, no API key,
runs locally and in CI.

## Metric

For each instance: ingest every session, rank sessions by the query score, then
- **recall@k** — a gold (answer) session appears in the top-k
- **MRR** — 1 / rank of the first gold session

Identical definition on both sides (Node for us, Python for incumbents) so the
numbers are comparable in one table.

## Modes (our retrieval)

| Mode | Function | Notes |
|------|----------|-------|
| `keyword` | `relevanceScore` | flat hit ratio |
| `idf` | `relevanceScoreIdf` + `buildDocFreq` | #1689 IDF ranking — the "multi" signal |
| `semantic` | `semanticRerank` (Ollama `nomic-embed-text`) | optional; **skipped** if the embed model isn't pulled |

## Run

```bash
# our retrieval (fixture, keyword+idf, k=5)
node experiments/memory_recall_bench.js

# against a REAL dataset (drop the file in data/longmemeval/ first)
node experiments/memory_recall_bench.js --dataset data/longmemeval/longmemeval_s.json --k 5 --modes keyword,idf,semantic

# incumbents on the SAME dataset (skips engines that aren't installed)
python experiments/memory_bench_incumbents.py --engines mem0,letta

# CI gate — asserts the harness measures real signal
node experiments/memory_recall_bench.js --selftest
node --test tests/test_memory_recall_bench.js
```

Both writers append to `data/eval/leaderboard.jsonl` (`benchmark: "longmemeval"`)
and the Node harness also appends a full record to `data/longmemeval/runs.jsonl`.

## Getting a publishable number

The committed `data/longmemeval/fixture.json` is **synthetic** — it exists so the
harness runs offline and so the IDF advantage is demonstrable in a unit test. It
is **not** a benchmark result. For a publishable number, download the official
LongMemEval dataset to `data/longmemeval/longmemeval_s.json` (gitignored) and
re-run. Then install at least one incumbent (`pip install mem0ai`) to fill the
head-to-head column.

## Current fixture result (synthetic — illustrative only)

| mode | recall@5 | mrr |
|------|----------|-----|
| keyword | 0.667 | 0.714 |
| idf | **1.000** | **1.000** |

The fixture's `q1` is adversarial: the gold session matches only the *rare* query
term while six distractors each match two *common* terms — flat keyword ranking
drops gold below top-5, IDF ranking recovers it (+0.333 recall). This mirrors the
#1689 finding direction; a real dataset is required before any external claim.

## Honest status

- ✅ Our retrieval: fully runnable + CI-tested now.
- 🟡 Incumbent column: adapter is **wired** but runs only once `mem0ai`/`letta`
  are installed + configured; Mem0/Letta extract *facts* rather than store raw
  sessions, so recall is mapped via per-item `session_id` metadata (documented in
  the adapter). Treat cross-engine numbers as session-recall, the LongMemEval unit.
- 🟡 Real dataset: not committed (gitignored); fixture only until downloaded.
