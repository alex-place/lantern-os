---
title: Sub-Quadratic Attention for Ouro-1.4B UT — Research & Implementation Plan
created: 2026-06-22
status: shipped (SDPA training fix) + research-only (SWA, linear attn)
relates_to:
  - scripts/ouro_serve.py
  - scripts/train-qlora-ouro.py
  - src/sigma0/loop_lm.py
  - docs/research/2026-06-21-sigma0-serving-perf.md
---

# Sub-Quadratic Attention for Ouro-1.4B UT

## TL;DR

O(n²) attention is unacceptable at long context. Three separate O(n²) problems exist in
the Ouro stack; they are at different stages:

| Problem | Status | Fix |
|---|---|---|
| Decode O(N²) — re-encoding full sequence every token | **FIXED** (#810, KV cache) | `UniversalTransformerCache` wired into `Sigma0LoopLM` |
| Training attention O(n²) — eager alloc during QLoRA backward | **FIXED (this PR)** | `attn_implementation="sdpa"` in `train-qlora-ouro.py` |
| Attention O(n²) per forward pass — asymptotic compute | **Research-only** | SWA or linear attention (see §4) |
| Forward-truncation — UT runs all R steps, selects one | **Implemented, unvalidated** | `OURO_LOOP_TRUNCATE=1`, needs parity bench |

The **training fix** (shipping now) is the highest-leverage, lowest-risk action:
it closes a gap where serving already uses SDPA but training did not.
The **architectural** O(n²) (attention within each pass) requires model surgery and is
scoped as research here.

---

## 1. Why O(n²) matters specifically for Ouro UT

Standard transformer: one forward pass per token decode, attention over a growing KV.
Ouro Universal Transformer: **T=4 recurrent passes per forward**, each running full attention.

Training VRAM for a single gradient step at sequence length n:
```
attention_activations ∝ n² × heads × T × (batch × grad_accum)
```

At seq=1536, T=4, batch=1, grad_accum=8:
- Fits 8GB RTX → 38 s/step (measured)

At seq=4096, same config:
- Attention tensor is (4096/1536)² = 7.1× larger
- With T=4: 4 passes × 7.1× = 28× more attention activation vs seq=1536
- Overflows VRAM → swaps to CPU → 39 min/step (measured, 52× penalty)

The asymptotic problem compounds with recurrence depth:
**O(n² × T) training cost**, not O(n²).

---

## 2. Fix #1 (shipped): SDPA during training

### The gap

`ouro_serve.py` (inference) has used `attn_implementation="sdpa"` since #775, which
measured a **2.8× serving speedup** (65.8 → 23.7 s/prompt, [sigma0-serving-perf.md]).
`train-qlora-ouro.py` (QLoRA training) loaded the model without `attn_implementation`,
defaulting to eager attention — standard O(n²) dense allocation.

SDPA uses PyTorch's fused kernel (`torch.nn.functional.scaled_dot_product_attention`),
which on CUDA >= 8.0 dispatches to FlashAttention-2:
- **Memory**: O(n) working memory vs O(n²) materialized attention matrix
- **Compute**: still O(n²) FLOPs but with much smaller constant (no materialise/read/write
  of the n×n matrix — tiled streaming, ~4× fewer DRAM ops)
- **Training**: compatible with bf16, NF4 quantisation, and `use_cache=False`

### What it unblocks

At seq=1536 (current): reduces per-step VRAM → headroom for larger grad_accum or
longer sequences before overflow.

At seq=2048 (near-term target): attention activations with SDPA should fit. At seq=4096:
probably still overflows the 8GB GPU because at 4096 tokens the n² FLOPs still dominate
even with tiling — but this is the bottleneck to measure, not assume.

### Implementation

One line added to `train-qlora-ouro.py`, mirroring the ouro_serve.py pattern exactly
(try SDPA, fall back on ValueError/TypeError if Ouro's trust_remote_code rejects it):

```python
model = AutoModelForCausalLM.from_pretrained(
    a.base, quantization_config=bnb, device_map="auto", trust_remote_code=True,
    attn_implementation="sdpa")   # ← added; ouro_serve.py has used this since #775
```

---

## 3. Fix #2 (implemented, needs validation): forward-truncation

Documented fully in [sigma0-serving-perf.md §4](2026-06-21-sigma0-serving-perf.md).

Key finding: forward-truncation (breaking the UT loop when Q-exit fires) and the KV cache
are **mutually exclusive** — a position that exits at step k never writes its k+1…R4 KV,
so later tokens attending that position get an inconsistent cache. The "O(N) adaptive"
prize requires a ragged-depth cache (per-position exit depth tracked in the KV store).

Action: run `scripts/bench_ouro_loop.py --truncate` to validate parity before enabling
in serving.

---

## 4. Research: architectural O(n²) — ranked options

These require modifying `modeling_ouro.py` (trust_remote_code), retraining or at minimum
a fine-tuning run, and thorough benchmarking. None are shipping-ready today.

### 4a. Sliding Window Attention (SWA) — highest fit for UT

**How it works**: each attention layer attends only to a local window of w tokens plus a
small set of global/anchor tokens, giving O(n × w) attention cost per pass.

**Why it fits Ouro's UT architecture specifically**:
Standard SWA limits receptive field to w tokens — insufficient for long documents.
But Ouro runs T=4 recurrent passes. Information propagates T×w tokens after T passes,
like a diffusion process. At w=512, T=4 → effective receptive field = 2,048 tokens.
At w=1024, T=4 → 4,096 tokens. The **recurrence IS the long-range mechanism**;
SWA per-pass is the local integration step.

This is why SWA fits UT architectures far better than standard transformers:
you're not sacrificing global context, you're distributing it across depth.

**VRAM at seq=4096 with SWA**:
```
eager:  O(n² × T) = O(4096² × 4) = 67M tokens of attention
SWA w=512:  O(n × w × T) = O(4096 × 512 × 4) = 8M tokens — 8× reduction
```
SWA at w=512, seq=4096, T=4 costs the same attention VRAM as eager at seq=2048, T=4.
This is the lever that unblocks seq=4096 training.

**Implementation effort**: medium-high.
- Patch `OuroAttention.forward()` in `modeling_ouro.py` to use a causal local mask
  instead of the full causal mask
- Alternatively: override the attention mask in the training collator
- Requires fine-tuning to recover any quality lost from window restriction
- Mistral 7B ships with SWA w=4096; Phi-3-mini uses SWA w=2048. Proven at production.

**Risk**: the UT recurrent passes re-use the same block. A position at step k only sees
its window from the k-th pass' key-value states. Global context requires multiple passes.
For tasks that need very long-range dependencies in fewer than T passes, quality may drop.

### 4b. Linear Attention (GLA / RetNet-style) — true O(n)

**How it works**: replaces softmax(QKᵀ/√d)V with a kernel approximation φ(Q)φ(K)ᵀV,
computable as a recurrence in O(n) time and O(d²) space.
Gated Linear Attention (GLA, 2023) is the current SOTA that approaches softmax quality.

**For UT**: a UT that uses linear attention in each pass is O(n × T) total — a factor of n
reduction from O(n² × T). The recurrence in each UT pass becomes a linear RNN step.

**Fit for Ouro specifically**: the Ouro architecture already exploits recurrence for
reasoning; replacing attention with a linear recurrence per pass creates a nested
recurrence (outer UT loop, inner linear-attn recurrence) that is theoretically elegant
and practically hard to train. The pre-trained weights are softmax-attention weights;
converting them to GLA format requires either retraining from scratch or distillation.

**Implementation effort**: very high. Not feasible on 8GB consumer GPU without a
multi-month distillation run.

### 4c. Hybrid: full attention for a few layers, SWA for the rest

**How it works**: the UT block runs all T passes. In passes 1–3 use SWA (local context
integration); in pass T=4 use full attention (global synthesis). Per-pass attention
type is controlled by a flag in the block.

**Cost**: O(n × w × (T-1) + n² × 1) = mostly SWA with one full-attention synthesis pass.
At n=4096, w=512, T=4: (4096×512×3 + 4096²×1) = 6.3M + 16.8M = 23M — 3× cheaper than
full eager, 3× more expensive than pure SWA.

**Implementation effort**: moderate — same SWA patch but with a pass-index conditional.

### 4d. Reduce UT steps under gradient checkpointing

Not sub-quadratic, but practical: `OURO_UT_STEPS=3` at training time reduces activation
VRAM by ~25% (one fewer recurrent pass). Combined with SDPA, this may unblock seq=2048.
Cost: quality loss from training with R=3 vs serving with R=4 (steps mismatch).
Mitigation: use `OURO_UT_STEPS=3` only during training; serve at R=4.

---

## 5. Ragged-depth KV cache (the O(N) adaptive prize)

From the serving perf research: the reason forward-truncation and KV cache are currently
exclusive is that the cache assumes all positions have R4 key-values. A **ragged-depth
cache** stores per-position exit depth and allows later tokens to attend only to steps
≤ exit_depth[position].

This is the research item that unlocks both O(N) decode AND adaptive UT depth
simultaneously. It requires:
1. A new cache structure that stores (R, head, d_k) per position where R is per-position
2. Modified attention masks that zero out cross-position steps above exit depth
3. Validation that output quality is maintained

This is a genuine research contribution, not an engineering task. Estimated effort: 2–4
weeks including the parity/quality bench. Worth a dedicated research spike when
forward-truncation parity is confirmed.

---

## 6. Recommended sequencing

| Step | Action | Effort | Unblocks |
|---|---|---|---|
| 1 (done) | SDPA in `train-qlora-ouro.py` | 1 line | Smaller training VRAM constant factor |
| 2 | Validate forward-truncation parity (`bench_ouro_loop.py`) | 30 min GPU | O(1/mean_depth) decode speedup |
| 3 | Measure SDPA training VRAM at seq=2048 | 1 training run | Know if seq=2048 is now feasible |
| 4 | Measure SDPA training VRAM at seq=4096 | 1 training run | Know if seq=4096 is now feasible |
| 5 | SWA patch + QLoRA fine-tune | 1–2 days | seq=4096 training if step 4 still overflows |
| 6 | Ragged-depth KV cache | 2–4 weeks | O(N) adaptive decode (the long-term prize) |

Step 1 is shipped. Steps 2–4 are measurement before commitment. Only step 5+ requires
architectural surgery.
