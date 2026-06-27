# Ouro-1.4B HumanEval Training Research — 2026-06-26

**Author:** Claude (autonomous training cycle)
**Scope:** Why Ouro-1.4B HumanEval pass@1 was stuck, what the real bar is, and how
QLoRA fine-tuning on open-source code data actually behaves (overfitting curve,
contamination, and the recovered peak).

---

## TL;DR

1. **The "75% champion" was a labeling bug.** Upstream commit `008d04cb` (fixes #1170)
   proved the leaderboard row `ouro-coding-v3-he20` was actually **Qwen2.5-Coder-3B**,
   not Ouro-1.4B. The genuine Ouro-1.4B bar is the **35%** `ouro-fixed-harness` run
   (base model + the fixed extraction harness). The ≥75% goal belongs to a different,
   larger, code-specialized model class.
2. **Most of the original "10% pass@1" was a harness bug, not the model.** Fixing
   completion extraction took base Ouro-1.4B from 10% → 35% with no retraining.
3. **Training format matters more than training volume.** Instruction/Response-wrapped
   data makes Ouro emit `assistant\n<chain-of-thought>` instead of code (≈30%).
   Raw-completion format is correct and trains a healthier objective (loss ~0.5 vs 1.5).
4. **More epochs strictly hurt.** An 8.6-epoch run degraded HumanEval to 10%
   (loss collapsed to ~0.005 = memorization). The peak lives at **< 2 epochs**.
5. **A dense early-epoch sweep beat the bar:** checkpoints at epoch 0.48 and 1.91 hit
   **50% headline** pass@1 on the first 20 problems — but see the contamination caveat.
6. **Contamination caveat (important):** the training set included HumanEval
   "self-study" on **even-indexed** problems, which inflates any eval that includes
   them. Held-out (odd-indexed) pass@1 is the honest metric; preliminary held-out is
   **~40%** (4/10 on the first-20 odd problems). A full 164-problem held-out eval was
   in progress at time of writing (see "Open items").

---

## 1. Background

The standing task is a weekly GPU training cycle to push Ouro-1.4B (`ByteDance/Ouro-1.4B`)
HumanEval pass@1 toward a target that was believed to be 75%. Training is QLoRA
(LoRA r=16/α=32, 4-bit NF4) via `scripts/train-qlora-ouro.py`; evaluation is the
canonical 164-problem HumanEval with sandboxed subprocess execution via
`scripts/eval_humaneval_ouro.py`.

## 2. The harness was the first bottleneck (10% → 35%)

The model originally scored ~10% pass@1. Investigation showed the failures were
almost entirely **completion-extraction** problems, not generation problems:

- `he_prompt` ends with `\n` (no indentation); Ouro emits the body at column 0, so
  `he_prompt + body` produced `unexpected indent` on the first sub-statement.
  Fixed with `_normalize_body_indent`.
- A drop-lines fallback was masking the repair path (it reduced functions to a
  docstring-only stub that compiled but did nothing). Restructured into a two-pass
  `make_candidate` (clean-compile pass, then drop-lines).
- Anti-repetition false positives were truncating valid bodies; switched to a
  prefix-based repetition detector.
- **Chat-prefix leakage:** models trained on conversational data emit a leading
  `assistant:`/`assistant\n` token. Added a regex strip before extraction.

Net: base Ouro-1.4B went from **10% → 35%** with no retraining. This is the honest
incumbent bar.

## 3. Format beats volume

Two training datasets were tried:

| Dataset | Format | Result |
|---|---|---|
| Lantern PRs + Claude sessions (341 rows) | `### Instruction / ### Response` | 30% (and 50-epoch variant collapsed to chat chain-of-thought) |
| MBPP + CodeAlpaca + HumanEval self-study (2509 rows) | **raw completion** | see §4 |

The instruction-wrapped data is actively harmful for a *completion* benchmark: the
model learns to answer conversationally (`assistant\n Let me think...`) rather than
continue code. Training loss starting at ~1.5 (instruction) vs ~0.5 (raw completion)
is the tell — raw completion is the natural objective for HumanEval.

## 4. The overfitting curve (the central finding)

Training the 2509-row raw-completion set to **8.6 epochs** (2700 steps) drove training
loss to ~0.005 — memorization. HumanEval pass@1 on the surviving checkpoints:

| Checkpoint | Epochs | pass@1 (first 20) |
|---|---|---|
| checkpoint-1050 | 3.3 | 30% |
| checkpoint-1650 | 5.3 | 25% |
| final (2700) | 8.6 | 10% |

**Monotonic decay** — every additional epoch past ~3 *lowered* held-out performance.
`save_total_limit` had pruned the earlier (epoch 0.5–2.9) checkpoints, so a second
**peak-finding run** trained a fresh adapter to only 3.18 epochs and retained all
checkpoints. The dense sweep:

| Checkpoint | Epochs | pass@1 (first 20) |
|---|---|---|
| **checkpoint-150** | 0.48 | **50%** |
| checkpoint-300 | 0.96 | 40% |
| checkpoint-450 | 1.43 | 40% |
| **checkpoint-600** | 1.91 | **50%** |
| checkpoint-750 | 2.39 | 40% |
| checkpoint-900 | 2.87 | 40% |
| checkpoint-1000 | 3.18 | 35% |

Both 50% results reproduced **deterministically** on re-run (greedy decoding). The
8.6-epoch run had buried a genuinely stronger model under 6+ epochs of overfitting.

## 5. The contamination caveat

`scripts/prep_opencode_training.py` added HumanEval "self-study" on **even-indexed**
problems (`i % 2 == 0`) to the training data. The "first 20" eval (problems 0–19)
therefore contains 10 problems the model was trained on. Splitting checkpoint-600's
first-20 result:

- **Seen (even, in training):** 6/10 = 60%
- **Held-out (odd, never seen):** 4/10 = 40%

So the honest, generalization number on this small held-out slice is **~40%** — still
above the 35% bar, but the headline 50% was inflated by ~10–15 points of memorized
problems. **Lesson: never put benchmark problems (even a subset) into training data,
and always report held-out pass@1.**

## 6. An infrastructure lesson (Windows process management)

A multi-hour detour was caused by `ps aux | grep` (msys) giving **false negatives**
for Windows `python.exe` — live training runs appeared dead, so multiple were stacked,
saturating VRAM (14/16 GB) and thrashing the disk so badly that `import datasets` went
from <2s to 85s. Fix: detect/kill via PowerShell `Get-CimInstance Win32_Process`, and
note that `.venv-train` is a shim (one run = 2 python.exe processes; the worker is the
one with growing CPU time and ~1.7 GB RSS). Never run other torch/CUDA jobs (proof
scripts, pytest) concurrently with training.

## 7. Recommendations

1. **Train ≤ 2 epochs** on raw-completion code data; keep **all** early checkpoints
   (`save_total_limit` high or `save_steps` small) and select on held-out pass@1.
2. **Remove the HumanEval self-study** rows from `opencode-completion.jsonl` (or keep
   them only for a separate study), so the eval is never contaminated.
3. **Always report held-out (odd-indexed) pass@1**, not the contaminated first-20.
4. **Promotion gate:** only promote an adapter whose *held-out* pass@1 beats the
   35% incumbent on a large sample (≥ 80 problems).
5. To meaningfully exceed ~50%, change the **base model** (the 75% number came from a
   3B code-specialized model), not the epoch count — LoRA on the 1.4B general model
   plateaus in the 35–50% range on this data.

## 8. Open items

- **Full 164-problem held-out eval of checkpoint-600** (epoch 1.91) — in progress at
  time of writing; the odd-indexed (82-problem) pass@1 is the number that decides
  promotion. This report will be updated with that result.
- De-contaminate `opencode-completion.jsonl` and re-run a clean ≤2-epoch training.

## Artifacts

- Training: `scripts/train-qlora-ouro.py` (now supports `--resume auto`, eff. batch 8 →
  ~314 steps/epoch on the 2509-row set).
- Data prep: `scripts/prep_opencode_training.py` (MBPP + CodeAlpaca + HumanEval
  self-study → raw-completion format).
- Eval: `scripts/eval_humaneval_ouro.py` (adds the chat-prefix strip).
- Results: `data/eval/leaderboard.jsonl`.
- Adapters: `D:/lantern-train/ouro-sigma0-adapters/opencode-peak-1782489889/` (best:
  `checkpoint-600`).
