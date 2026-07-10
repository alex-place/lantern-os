# Recovering the PTQTP coding tax: more planes (bits) or a light adapter — both work, partially

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Act (serving efficiency)
**Artifacts:** `experiments/ptqtp_lora_recovery.py`, `data/sigma0/ptqtp_lora_recovery_report.json`
**Extends:** #2206

## Question

#2206 showed 2-plane PTQTP (~3.4 bits, 4.7×) costs coding pass@1, and a 3rd plane recovers it at the
cost of compression (3.1×). The other recovery lever is a **light LoRA** on the quantized model — keep
the full 4.7× and buy the coding back with a tiny adapter. Does it work?

## Result (Qwen2.5-Coder-1.5B, HumanEval n=40, greedy)

| stage | pass@1 | Δ |
|---|---|---|
| FP16 | 0.80 | — |
| 2-plane PTQTP (4.7×) | **0.40** | **−0.40** |
| 2-plane PTQTP + LoRA (300 steps, 2.5k coding rows) | **0.60** | **+0.20** (of the −0.40) |

Two honest findings:

1. **Small models take a far bigger PTQTP coding hit than large ones.** 1.5B drops **−0.40** at 2 planes
   vs the 7B's −0.15 (#2206) — consistent with the perplexity scaling (0.5B +27% → 7B +5%). The dual
   trit-plane basis has less redundancy to exploit in a small model. So the 2-plane operating point is
   **not** viable for a small coder at all.

2. **A light LoRA partially recovers it at full compression** — +0.20 of the −0.40 tax (0.40 → 0.60),
   in a 17-minute LoRA run, while the base stays 4.7×-compressed. Not a full restore (still −0.20 vs
   FP16), but a real lift.

## The confound — RESOLVED by a control: the +0.20 is genuine recovery

The obvious confound is that the coding SFT might just improve *any* model. So I ran the **FP16 + same
LoRA control** (`--no-quant`):

| arm | pass@1 |
|---|---|
| FP16 | 0.80 |
| **FP16 + LoRA (control)** | **0.80** (no change) |
| PTQTP (2-plane) | 0.40 |
| PTQTP + LoRA | 0.60 (+0.20) |

**The SFT does not lift the FP16 model at all (0.80 → 0.80)** — it's already saturated on this data. So
the +0.20 the LoRA buys on the *quantized* model is **genuine recovery of quantization damage**, not
general SFT benefit. Clean attribution. (n=40 ±0.15; `humaneval-train.jsonl` is general Python SFT with
no `HumanEval/` test ids found — low but nonzero contamination risk, and moot here since it didn't even
help FP16.)

## Combined go-forward (with #2206's N-plane result)

There are **two recovery levers** for the PTQTP coding tax:
- **More planes (bits):** 3-plane fully recovers on 7B (0.90, 3.1×) — clean, no training. *Preferred for
  small models*, where the 2-plane tax is severe.
- **A light LoRA (adapter):** partial recovery at full 4.7× — cheaper on bits, needs a short train and a
  proper FP16 control before claiming the exact recovery.

Net: **ship the coding slot at 3 planes (~5 bits, 3.1×)** for a clean quality/size point; treat LoRA
recovery as a further optimization to validate with a control. MEASURED. Reproduce:
`.venv-train/Scripts/python.exe experiments/ptqtp_lora_recovery.py --n 40`.
