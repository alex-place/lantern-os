### Added
- **On-target eval for the Ouro honesty adapter (epistemic classifier).** `experiments/epistemic_eval.py`
  scores the task the honesty LoRA was actually trained for — classify a statement as
  `PROVEN | MEASURED | HEURISTIC` + `VERIFIED: yes|no` — against a fresh held-out set
  (`data/eval/epistemic-heldout.jsonl`, 24 statements) with a runtime contamination guard and
  deterministic exact-match grading. **MEASURED:** base Ouro-1.4B **0/24 (0%)** — never emits the
  format; `ouro-honesty-balanced` adapter **22/24 (91.7%)** BOTH-correct, memorization ruled out
  (held-out, guard passed). Residual failure mode: open conjectures (Riemann hypothesis) occasionally
  promoted HEURISTIC→PROVEN.
- **Local HaluEval-QA harness** (`experiments/halueval_local.py`) — closed-book base-vs-adapter over
  `data/eval/halueval-qa-subset.jsonl`.

### Fixed / Data quality
- **Added conjecture examples to the HEURISTIC training slice** (Collatz, Hodge, BSD, Navier-Stokes,
  abc, Legendre, …; distinct from the held-out eval set) to correct the adapter's tendency to stamp
  open conjectures as PROVEN. `data/sigma0/ouro_honesty_train_balanced.jsonl` 137→147 rows.
- **Removed changelog-message pollution from `data/sigma0/ouro_honesty_train.jsonl`** (343→103 rows;
  250 leaked git commit messages had been mislabeled `MEASURED/yes`). The *balanced* file used for
  the actual training run was already clean, so the shipped adapter was not affected.

### Notes
- **HumanEval (greedy, n=20):** adapter 25% vs base 10% — coding **not damaged** by the honesty tune
  (small n, treat as parity not gain).
- **Caveat on `experiments/halueval_ab.py`:** its `contains-gold` substring grader yields false
  positives on yes/no and "which-came-first" questions (gold string appears incidentally in a longer
  fluent answer). The adapter's apparent 95%→60% closed-book "hallucination" drop is largely this
  artifact plus added verbosity — **not** a validated honesty gain. Use the epistemic eval above for
  the real signal.
