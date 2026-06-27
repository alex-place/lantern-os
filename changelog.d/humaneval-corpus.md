### Added
- `scripts/build_humaneval_corpus.py` — builds a HumanEval-optimized, decontaminated
  code-generation corpus (Magicoder OSS-Instruct + bigcode self-oss-instruct + MBPP
  train/val) for the local Ouro QLoRA adapter. 13-gram overlap decontamination against
  HumanEval; MBPP test split excluded by construction.
