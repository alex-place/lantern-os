### Training: self-contained Colab notebook for the HumanEval Ouro adapter

- New `notebooks/humaneval_ouro_colab.ipynb` runs the whole flywheel on a cloud Ampere GPU (A100/L4): build the decontaminated HumanEval corpus → QLoRA-train Ouro-1.4B → eval HumanEval pass@1 → optional push to HF Hub.
- Exists because the local RTX 3070 can *train* the recurrent Ouro LoopLM but **cannot decode/eval** it (a 16-token probe didn't finish in 450s — it VRAM-swaps). On A100/L4 the stock cached `generate()` is fast, so the notebook produces a real pass@1.
- Self-contained: no repo clone, no local upload. Mirrors `build_humaneval_corpus.py` (13-gram HumanEval decontam, MBPP test split excluded), `train-qlora-ouro.py` (bf16/4-bit, all-linear LoRA, completion-only loss, ROPE patch), and `eval_humaneval_ouro.py` (faithful sandboxed execution). Toggle `TRAIN=False` + point `ADAPTER` at an HF repo for eval-only.
