feat(sigma0): make the ADR-0015 Qwen-teacher crystallization front-half runnable

Turns `scripts/qwen_teacher_crystallize.py` from scaffold into a runnable front-half
(propose → verify → scrub → decontaminate → pack), still offline/opt-in and still
never training/eval/promoting (that stays `continual_ouro_pipeline.py`, GPU-gated):

- **Live Qwen proposer wired.** `propose_with_qwen()` now calls a local Qwen2.5-Coder
  over the established Ollama/OpenAI-compatible `/api/chat` pattern (urllib, stream=false,
  mirrors `eval_coding_ouro.py`). A robust parser accepts a JSON object, a fenced code
  block, or bare code; derives the fn name and lifts top-level asserts out of the body.
  Endpoint/parse errors yield fewer candidates, never a mid-corpus crash — Qwen proposes,
  the green-subprocess gate is the teacher of record.
- **Schema aligned to the verify gate.** Candidates now use the exact
  `{fn, instruction, code, asserts:[list]}` shape that
  `build_ouro_coding_dataset.load_extra_candidates` consumes — fixing a latent scaffold
  mismatch where the real gate would have dropped every row.
- **Decontamination stage wired** (was described in the docstring but never called): drops
  verified rows sharing ≥1 normalized 13-gram with HumanEval/MBPP before they can enter the
  corpus (benchmark-never-the-target, ADR-0010), reusing `decontaminate_training.py`.
  Loud-skips if the HF datasets are unavailable so an offline run is never mistaken for
  clean. New `--no-decontaminate` / `--min-overlap` flags.
- **Provenance + Convergence Record** unchanged (`meta.proposer`, `meta.verification`);
  the record now also logs verify-dropped / benchmark-dropped / decontaminated counts.

Loop stage: Converge (verified experience → corpus), Verify-gated throughout. ADR-0015
remains Proposed — this does not start a training run. Covered by
`tests/test_qwen_teacher_crystallize.py` (11 tests, no GPU/endpoint) + the upgraded
`--self-test` (now exercises the REAL verify gate + decontamination).
