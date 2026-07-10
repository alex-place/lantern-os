# PTQTP dual trit-plane quantization holds on our Qwen coder — 7B loses only ~5% perplexity at ~3.4 bits

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Act (serving efficiency)
**Artifacts:** `experiments/ptqtp_quantize.py`, `experiments/ptqtp_coding_eval.py`, `data/sigma0/ptqtp_report.json`, `data/sigma0/ptqtp_coding_report.json`
**Issue:** #2206 · **Method:** PTQTP, arXiv:2509.16989

## What / why

Our own **naive** ternary collapsed (×6864 blowup — `posthoc-quantization-cliff-measured`). PTQTP claims a
**structured** post-hoc dual-ternary quant rivals 1.58-bit QAT quality in ~1 hour, no training. This is
the cheapest local-first shrink if it holds on *our* served Qwen coder — so I reimplemented it faithfully
and measured.

## Method (faithful to Algorithm 1)

Each linear weight is flattened into **groups of G=128**. Each group is approximated by **two ternary
planes + two continuous scales**: `W_g ≈ α1·T1 + α2·T2`, `T ∈ {−1,0,1}^G`, `α ∈ ℝ²`. Alternating
optimization to convergence: (a) closed-form **ridge** solve for the two per-group scales
(`α = (SᵀS + λI)⁻¹ SᵀW_g`, λ bumped when ill-conditioned), (b) per-element **9-way argmin** over
(t1,t2) ∈ {−1,0,1}². Weight-only, **no calibration**. Effective ~**3.42 bits/weight** (2 trits + 2 fp16
scales per 128) → ~**4.7× vs FP16** (≈10× with 5-trit/8-bit packing).

## Result — perplexity (diverse prose + code), FP16 vs PTQTP

| model | FP16 ppl | PTQTP ppl | ratio | mean rel-err/layer | quant time |
|---|---|---|---|---|---|
| Qwen2.5-Coder-0.5B | 1.379 | 1.751 | 1.27 | 0.194 | 14 s |
| Qwen2.5-Coder-1.5B | 1.254 | 1.480 | 1.18 | 0.190 | 50 s |
| **Qwen2.5-Coder-7B (served)** | **1.221** | **1.284** | **1.052** | 0.190 | 288 s |

**Quality holds, and improves with scale** — exactly the paper's story. On the **served 7B coder**, dual
trit-plane PTQTP costs only **~5% perplexity** at ~3.4 bits/weight, quantized in under 5 minutes with no
training. This is the opposite of the naive-ternary collapse: structured decomposition + per-group
scales is what makes ternary survivable. Larger model ⇒ smaller degradation (0.5B +27% → 7B +5%),
because the per-group ternary basis has more redundancy to fit.

## Coding capability (HumanEval n=20 greedy, FP16 vs PTQTP, 7B)

| | pass@1 | passed | failures |
|---|---|---|---|
| FP16 | **0.95** | 19/20 | 1 assertion |
| PTQTP | **0.80** | 16/20 | timeout, missing-`import math`, KeyError, assertion |

**Perplexity understates the coding cost.** The same quantization that costs only ~5% perplexity drops
**coding pass@1 by 15 points** (0.95 → 0.80), and the new failures are *real capability loss* — the
quantized model forgets an `import`, throws a `KeyError`, times out. So for a **coder specifically**,
~3.4-bit dual-ternary is **not** a free lunch, even though language-modeling perplexity barely moves.
(n=20 carries ±~0.13 binomial noise, so treat −0.15 as "clearly degraded, magnitude uncertain" — but
the direction and the failure modes are informative.)

## Verdict / go-forward

- **PTQTP's quality claim holds for perplexity** (7B: −5% ppl @ ~3.4 bits, and it improves with scale)
  — structured dual-ternary is genuinely survivable where naive ternary collapsed (×6864). This unblocks
  #2207 (T-SAR CPU ternary) on the *quality* precondition.
- **But it costs measurable coding accuracy** (−15 pts pass@1 at 7B/n=20). So PTQTP should **not** replace
  the FP16 served coder as-is — the coder needs the full-precision edge. Viable for memory-constrained
  *general* use; for the coding slot it needs the gap recovered first (more trit-planes on sensitive
  layers, mixed-precision keep-list, or a light QAT touch-up). Honest **conditional GO**: great shrink,
  real coding tax.
- **Caveat — this measures QUALITY, not speed.** The reconstructed weights are stored **dequantized
  (fp16)**, so tokens/s is unchanged here. The paper's 4.63× speedup needs a **packed-ternary
  multiplication-free matmul kernel** — that's exactly T-SAR's contribution (#2207) and is out of scope
  for this quality test. Integrating PTQTP into the serving path is worth it only once that kernel exists
  (otherwise it's smaller-on-disk but not faster).

## Honest scope

fp16 activations, weight-only PTQTP, group=128, ≤8 alternating iterations; perplexity on a fixed diverse
passage (a proxy, not a full WikiText run); dequantized-weight eval (no packed kernel). MEASURED, not
PROVEN. Reproduce: `.venv-train/Scripts/python.exe experiments/ptqtp_quantize.py --model <hf-id>`.
