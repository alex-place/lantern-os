### Fixed
- **Σ₀ Track B grounding corpus decontaminated** (#2143): the v1 (untracked) builder
  leaked all 66 heldout golden statements verbatim into training, echoed 3 of the 4
  `eval_sigma0_adapter` no-evidence probes, re-injected the continuum-hypothesis mislabel
  from stale JSONL exports, taught `confidence: 0.85` on 45% of rows, and collapsed the
  balanced epistemic slice 147→103. The builder is now tracked
  (`scripts/build_sigma0_grounding_corpus.py`), regenerates the key in-memory from
  `experiments/sigma0_seed_facts.py`, excludes every heldout id and eval-probe phrasing,
  drops degenerate one-word rows, bands confidence targets, refuses the glossed v1 key by
  default (retraining gated on corpus-v2, PR #2165), and is enforced by
  `tests/test_sigma0_grounding_corpus.py`. Stale `seed_facts.jsonl` / `golden_dataset.jsonl`
  exports regenerated. **ouro-sigma0-grounding-v1 is marked unbenchmarkable** on the
  66-fact heldout (`data/sigma0/ouro_sigma0_grounding_v1_contamination.json` +
  `CONTAMINATED.md` in the adapter dir).
