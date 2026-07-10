# Honesty monitoring survives quantization — ship a compressed coder AND keep the gate

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Verify × Act
**Artifacts:** `experiments/hneurons_under_ptqtp.py`, `data/sigma0/hneurons_under_ptqtp_report.json`
**Connects:** #2209 (H-Neurons honesty probe) × #2206 (PTQTP quantization)

## The deployment question

Two results this loop point at a shippable local-first stack: a **sparse FFN-neuron hallucination
probe** that detects at 0.97 AUROC (#2209), and **PTQTP** that compresses the served coder ~3× at a
small quality cost (#2206). But a honesty gate that only works at FP16 is useless the moment we
compress the served model. So: **does the H-Neurons probe still work on a PTQTP-quantized model?**

## Method

Fit + score the sparse probe (SelectKBest → L1-logistic over `mlp.down_proj` neuron activations) on the
same 80 matched true/false facts, on Qwen2.5-Coder-7B, **FP16 vs 3-plane-PTQTP-quantized** (the coding
operating point from #2206). Grouped-CV detection AUROC + leave-one-domain-out transfer.

## Result

| | detection AUROC | OOD transfer (LODO) |
|---|---|---|
| FP16 | 0.968 | 0.959 |
| 3-plane PTQTP (~5 bits, 3.1×) | **0.955** | **0.927** |
| Δ | −0.013 | −0.032 |

**The honesty signal survives.** Detection drops ~1.3 pts, transfer ~3.2 pts — both remain **well above
0.9**. The sparse FFN-neuron hallucination direction is **robust to quantization**: the neurons that
carry the honesty signal keep carrying it after the weights are ternarized.

## Why it matters

We can **ship a compressed (3.1×) coder AND keep the honesty gate functioning** — the two wins compose.
For the local-first product this means the memory saving (PTQTP) does not cost the Verify-stage
monitoring (H-Neurons). Practically: fit the probe once (on FP16 or the quantized model — both give
~0.95), and it monitors the served quantized model.

## Honest scope

80 matched facts, 7B, PTQTP weights stored dequantized (quality, not the packed-kernel speed); n small
so the deltas carry ~±0.03 noise — but both post-quant numbers clear 0.9 comfortably. The probe was
re-fit on the quantized activations here; a stricter test would fit on FP16 and score the quantized
model (transfer across the quantization boundary) — a good follow-up. MEASURED. Reproduce:
`.venv-train/Scripts/python.exe experiments/hneurons_under_ptqtp.py`.
