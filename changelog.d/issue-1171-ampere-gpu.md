### Prefer Ampere/bf16 GPU for Ouro training (#1171)

- `scripts/lightning_dispatch.py` no longer starts the studio on **T4** (Turing, no bf16 — bakes a NaN adapter for the Ouro QLoRA recipe). It now resolves `LIGHTNING_MACHINE` (default **L4**, Ada cc 8.9, native bf16) against the SDK `Machine` enum, **refuses** pre-Ampere T4 variants, and rejects unknown names with a clear error instead of silently training on the wrong hardware. (The Lightning SDK exposes no "A10"; L4 is the entry bf16 GPU, A100 the next step.)
- `gpu-training.pcsf.json`: `rotation_order` now **leads with Lightning** and keeps **Kaggle last** as a crash-free fallback for arch-tolerant jobs only; Lightning's GPU/notes/priority reflect the bf16 target.
- `training-dispatcher.js` forwards `LIGHTNING_MACHINE` (default L4) to the dispatch script.
