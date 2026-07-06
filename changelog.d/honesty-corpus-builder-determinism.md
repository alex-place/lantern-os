### Fixed
- **Honesty-corpus builder survives convergence-record schema drift.** `experiments/sigma0_s1_data_builder.py`
  crashed (`AttributeError: 'dict' object has no attribute 'strip'`) on newer `data/convergence/records.jsonl`
  rows whose `result` is a structured dict (three-doors scene records); it now flattens dict/list results
  deterministically. 5/6 tests in `tests/test_sigma0_ouro_honesty_corpus.py` were failing through this path.

### Changed
- **`experiments/sigma0_ouro_honesty_corpus.py` is now the single deterministic source of both shipped
  corpora** (`ouro_honesty_train.jsonl` 103 rows + `ouro_honesty_train_balanced.jsonl` 147 rows, 51.7%
  negatives — in the 0.40–0.55 design band), with the previously hand-applied policies encoded:
  - **Changelog-tuple purge (#2054)** — the ~250 commit-message tuples mislabeled `MEASURED/yes` that
    collapsed a training run to always-assert can never re-enter; a test fails on any non-golden,
    non-augment row.
  - **Conjecture-augment policy (#2054)** — each augment is tied to a SEED entity and emitted only if that
    entity is in the TRAIN shard; the six #2054 rows that taught HELDOUT entities (BSD, Navier–Stokes,
    P vs NP, perfect numbers) are replaced by assertive phrasings of train-shard entities (Unique Games,
    ETH, Jacobian, Hadamard, SHA-256, AES). Riemann/Goldbach excluded (epistemic-eval entities).
  - **Entity-level contamination guard** — keyword map covering every SEED negative, checked against
    `ouro_honesty_heldout_ids.json` at build time and in tests; coverage of the map is itself machine-checked.
  - **Reproducibility test** — the tracked corpus artifacts must match `build()` output exactly, so hand
    edits or builder changes without regeneration fail CI. Heldout manifest unchanged. The adapter that
    measured 91.7% remains pinned to the 137-row corpus at c028fb39.
  - Negative-fraction gate tightened from `>=0.20` to the 0.40–0.55 band on the balanced corpus.

Strengthens **Verify** — training-data honesty invariants are now machine-checked instead of hand-applied.
