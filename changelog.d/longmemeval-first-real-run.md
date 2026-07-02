# eval: first real LongMemEval run — flips the row to ✅

**Loop stage: Remember** (measured evidence for memory retrieval).

Downloaded the real `longmemeval_s` dataset (500 instances, 278 MB) and ran
`experiments/longmemeval_harness.py` (k=5, 189 scored): multi-signal recall@5
**0.709** / MRR **0.486** vs keyword **0.222** / **0.098**. Row appended to
`data/longmemeval/runs.jsonl` (force-added — the ledger is the evidence);
BENCHMARKS.md LongMemEval flipped 🟡 → ✅ with the measured numbers.
