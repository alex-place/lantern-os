### Added

- **spiral: Phase-1 VTD pipeline for the tiny coder — corpus generator + QLoRA trainer + held-out
  eval (ADR-0030).** The measured path to a more capable tiny model is weight distillation on
  verified traces (retrieval was shown to *hurt* the 0.5B). End-to-end pipeline:
  - `scripts/fetch_mbpp.py` — normalize MBPP (500) to the spiral task schema (`{id, entry_point,
    prompt, tests}`), entry point parsed from the reference solution.
  - `experiments/spiral_gen_traces.js` — run the verified cascade (`qwen2.5-coder:0.5b` → cloud
    escalate) over problems and emit **only exec-verified** `{prompt → solution}` traces; frontier
    rescues are flagged as the distill targets (the hard tail the tiny model can't yet do).
  - `scripts/train_qlora_qwen_coder.py` — QLoRA-VTD fine-tune Qwen2.5-Coder-0.5B on the corpus,
    using the model's **native chat template** (fair base-vs-adapter eval), completion-only loss,
    bf16 + 4-bit nf4, val-split best-checkpoint selection + overfit tripwire — on the local RTX
    3070 (`.venv-train`, torch cu121).
  - `scripts/eval_qwen_coder.py` — base vs base+adapter pass@1 on a **held-out** MBPP slice
    (never in training), exec-verified, same template + name tolerance.
  - `lib/spiral-tiers.js`: the name-tolerance shim now also covers Python (single-defined-function
    fallback), so MBPP's arbitrary function names don't undercount correct solutions.
