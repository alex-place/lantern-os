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

## Recovering the coding tax — a 3rd trit-plane (N-plane PTQTP)

Generalized PTQTP from the paper's dual plane to **P planes** (`W_g ≈ Σ_{k=1}^P α_k T_k`, ridge over P
scales, 3^P element search) and re-ran the 7B coding eval:

| planes | bits/weight | compression | HumanEval pass@1 | Δ vs FP16 (0.95) |
|---|---|---|---|---|
| 2 (paper dual) | 3.42 | 4.7× | 0.80 | −0.15 |
| **3** | 5.13 | 3.1× | **0.90** | **−0.05** |

**A third plane recovers most of the coding tax** (−15 → −5 pts) at the cost of compression (4.7× →
3.1×). So the coding degradation *is* buyable back with bits — the 2-plane point is over-compressed for a
coder, and ~5 bits (3 planes) is a much better quality/size operating point for the coding slot. (n=20,
so −0.05 vs −0.15 is "clearly better, 18 vs 16 of 20" — direction solid, exact magnitude noisy.)

## Verdict / go-forward

- **PTQTP's quality claim holds for perplexity** (7B: −5% ppl @ ~3.4 bits, and it improves with scale)
  — structured dual-ternary is genuinely survivable where naive ternary collapsed (×6864). This unblocks
  #2207 (T-SAR CPU ternary) on the *quality* precondition.
- **The 2-plane point costs coding accuracy** (−15 pts at 4.7×), but **a 3rd plane recovers it to −5 pts
  at 3.1×** (measured above). So the honest go-forward is: for the **coding slot**, serve **3-plane
  PTQTP (~5 bits, 3.1×)**, not the 2-plane point — you keep most of the coding capability and still get
  ~3× shrink. 2-plane (4.7×) is fine for memory-constrained *general* use where the coding edge doesn't
  matter. **GO with the plane count as the quality/size dial**, tuned to the slot.
- **Caveat — this measures QUALITY, not speed.** The reconstructed weights are stored **dequantized
  (fp16)**, so tokens/s is unchanged here. The paper's 4.63× speedup needs a **packed-ternary
  multiplication-free matmul kernel** — that's exactly T-SAR's contribution (#2207) and is out of scope
  for this quality test. Integrating PTQTP into the serving path is worth it only once that kernel exists
  (otherwise it's smaller-on-disk but not faster).

## Honest scope

fp16 activations, weight-only PTQTP, group=128, ≤8 alternating iterations; perplexity on a fixed diverse
passage (a proxy, not a full WikiText run); dequantized-weight eval (no packed kernel). MEASURED, not
PROVEN. Reproduce: `.venv-train/Scripts/python.exe experiments/ptqtp_quantize.py --model <hf-id>`.
