---
adr: 0026
title: Ternary (1.58-bit) as the distillation target format for the ≤8GB serving artifact
status: Accepted
date: 2026-07-07
deciders: Alex Place
approved-by: Alex Place (2026-07-07, in-session directive)
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE (ADR-0001): agents draft `Proposed` / `approved-by: pending` and never
  self-approve. This ADR was flipped to `Accepted` on the operator's explicit in-session
  instruction ("approve the adr", 2026-07-07). The agent recorded — did not grant — the
  approval; if the directing operator is not the authorized approver, this line makes it
  visible and revocable.
-->

# ADR-0026: Ternary (1.58-bit) as the distillation target format for the ≤8GB serving artifact

- Status: **Accepted** (operator-approved 2026-07-07)
- Loop stage: **Act** (model execution — the served artifact) with **Verify/Remember** hooks the substrate must preserve
- Relates to: [ADR-0024](0024-sigma0-frontier-training-program.md) (frontier program — this ADR **resolves the format half of its Phase-2 "distill to ≤8GB artifact" and open question D7 retention threshold**), [ADR-0021](0021-serving-substrate-retain-ouro-custom-loop.md) (custom Ouro loop — a hard integration constraint), [ADR-0025](0025-rlvr-dreaming-continual-updates-double-gated.md) / Σ_θ Model-Update Acceptance Gate (reused as the accept gate), [ADR-0015](0015-qwen-teacher-verified-distillation.md) (verified distillation shape), [ADR-0017](0017-surprise-gated-decoding.md) (mid-layer hidden-state monitor the format must not break)

## Reconciliation (read first)

This ADR **adds no new subsystem**. ADR-0024 already commits the program to
"**train frontier → distill to the ≤8GB local serving artifact**" (Phase 2) and leaves
**D7 (distillation retention threshold)** open. This ADR names the *format and method* of that
distillation target — **ternary/1.58-bit (W1.58A8)** — and the gate that accepts it. It does not
start a training run, does not change the frontier objective (ADR-0024), and does not swap the
serving loop (ADR-0021). It is the concrete answer to "distilled into *what*, verified *how*."

## Context

The distill target is bounded by the **8 GB serving box** (RTX 3070). MEASURED constraint
([[bigger-model-does-not-fit-8gb]]): a 14B-Q4 offloads ~34% to CPU and runs ~9× slower — Q4 caps
the box at ~7B. Ternary is **~1.6 bits/weight vs Q4's ~4**, so the same VRAM holds **~2–2.5× more
parameters**. The strategic point is not "shrink Ouro-1.4B" — it is: **ternary lets the 8 GB box
serve a model 2–2.5× larger than Q4 allows** (a 14B that didn't fit at Q4 plausibly fits ternary).
That directly serves ADR-0024's "distill a bigger frontier base down to the local artifact."

I researched the four caveats I had flagged as open (via the `!research` arXiv corpus + web,
2026-07-07). All four resolve into concrete decisions below; the two I got *wrong last cycle* are
corrected loudly:

- **CORRECTION 1 — "ternary needs QAT-from-scratch / can't cheaply distill FP→ternary."** Refined.
  **BitDistill** (arXiv:2510.13998, Microsoft) fine-tunes an *off-the-shelf FP model* (Qwen) to
  1.58-bit with FP-comparable accuracy, **10× memory / 2.65× faster CPU, no from-scratch pretrain**.
  Naive QAT-to-ternary *is* unstable and scales badly (its Fig 1: FP-gap grows 13.9→15.3 from
  0.6B→4B) — my instability worry was right, but a distillation recipe fixes it.
- **CORRECTION 2 — "ternary compute win is CPU-only."** Wrong. Microsoft BitNet now ships a
  **W1.58A8 CUDA kernel** (4 ternary packed → 1 int8, dp4a); **spbitnet** provides 1.58-bit + 2:4
  sparse CUDA kernels for **consumer Ampere (RTX 3060/3070-class)**. **Both serving targets (L4,
  3070) have GPU ternary kernels.** The compute win is reachable, not hypothetical.

## Decision

Adopt **ternary W1.58A8 as the canonical format of the ≤8GB serving artifact**, produced by a
**BitDistill-style QAT-distillation** from the FP frontier/teacher, accepted by the **existing Σ_θ
gate**, and served as a **layer-level kernel swap inside the custom Ouro loop**. The pipeline:

**S0 · Fork = QAT-distill (default).** Three options ranked: (a) **BitDistill QAT-distill** —
default, recovers FP accuracy; (b) **PTQ ternary** (CAT-Q arXiv:2606.26650 / TWLA arXiv:2606.13054)
— cheap fallback if QAT compute is unavailable, at quality risk; (c) native-ternary pretrain — only
if the frontier is trained ternary from token one (defer; owned by ADR-0024 Phase 3, not here).

**S1 · FP teacher unchanged.** The ADR-0024 GRPO/L4 run stays **FP16**; keep master weights. Ternary
touches nothing on the train side — the teacher must be full-precision to distill *from*.

**S2 · SubLN refit.** Insert BitNet's SubLN sub-layer norms into the student before quantizing
(required for low-bit optimization stability, BitDistill §2). Student init'd from FP weights; the
norms train fresh.

**S3 · Continual-pretrain warm-up.** A short QAT-mode continued-pretraining pass on general corpus
**before** task distill — BitDistill's crucial step; skipping it is *why* naive QAT scales poorly.
Weighted heavier here than in the task-specific paper, because our artifact must stay general
(not a single downstream task).

**S4 · Attention distillation.** MiniLM-style multi-head attention-relation distillation, ternary
student ← FP teacher, on domain data. Quantizer = per-tensor **absmean → {−1,0,+1}** weights,
**8-bit activations** (per-token absmax/absmean), i.e. **W1.58A8** (BitDistill Eq 1–3).

**S4a · Activation-outlier mitigation (worked caveat).** W1.58A8 assumes activations survive INT8;
heavy-tailed layers break it. **Decision:** apply **Hadamard/rotation smoothing** (ITQ3_S
arXiv:2603.27914) as the default pre-smoothing, with **OffQ offsetting** (arXiv:2606.07116) or
**Bit-by-Bit outlier-channel-splitting** (arXiv:2604.07888) as escalations for any layer that still
fails the per-layer range check measured during S3. TWLA (arXiv:2606.13054) is the PTQ-path fix if
S0 falls back to (b).

**S5 · Accept via the existing Σ_θ gate (worked caveat = measurement).** The ternary student is a
**weight update** → run it through the **Σ_θ Model-Update Acceptance Gate** (ADR-0025) against the
FP teacher on **fresh holdout**. Accept **iff** degradation is within the D7 budget on the marks
already in [docs/BENCHMARKS.md](../BENCHMARKS.md): **HumanEval / MBPP pass@1** as the capability
floor, perplexity as the smoke signal, and the honesty marks (HaluEval / AbstentionBench) so
ternarization can't silently trade away ADR-0024's defining property. No new gate; no vendor number.

**S6 · Serve = kernel swap inside the custom loop (worked caveat = hardest constraint).** ADR-0021
keeps Ouro's **weight-tied recurrent `transformers` loop** (Q-exit + `output_hidden_states` for the
ADR-0017 probe). Therefore ternary ships as a **layer-level swap** — replace `nn.Linear` in the
recurrent block with ternary-kernel-backed ops (BitNet W1.58A8 CUDA / spbitnet on Ampere) **inside
`ouro_serve.py`**, preserving the loop, Q-exit, and mid-layer hidden-state hooks. **We do NOT adopt
bitnet.cpp's runtime** (llama.cpp-derived: fixed-depth, no Q-exit, no hidden-state API) — that would
violate ADR-0021. The kernel is a matmul, not a serving engine; the swap is feasible precisely
because it is a torch-op replacement, not a runtime port.

**Program invariants (inherited):** evidence-classed claims; GPU-hour anchors, no invented prices;
Σ_θ kill-gate on the artifact; honesty bound to external marks the model can't control; one loop,
no sprawl; operator authority over the gate.

## Consequences

- **Positive:** unlocks a **2–2.5× larger** served model on the 8 GB box than Q4 (the real payoff);
  reuses the entire train (ADR-0024), gate (ADR-0025), and serving (ADR-0021) stack — the only new
  code is the S2–S4 distill recipe + the S6 layer swap; GPU kernels exist for both targets;
  ternarization is gated by the same honest holdout as any weight update.
- **Negative / risks:** **kernel↔custom-loop integration is the real work** — BitNet/spbitnet
  kernels are validated inside stock runtimes, not inside a weight-tied recurrent loop with
  `output_hidden_states`; the swap must be proven to keep Q-exit + probe hooks intact (S6 is the
  load-bearing risk, not the math). QAT-distill costs L4 hours (S3+S4). Ternary still carries a
  residual quality gap vs FP (HGF arXiv:2602.05269 reports the naive 20–25% perplexity hit the
  recipe must close); S5 is the honest stop if it doesn't. spbitnet's 2:4-sparse path adds a
  second quantization axis (Sparse-BitNet arXiv:2603.05168) — opt-in, not baseline.

## Alternatives considered

- **Stay on Q4/Q4_K_M (status quo).** Rejected as the *target* format: Q4 caps the 8 GB box at ~7B
  (MEASURED); it forecloses the "serve a bigger distilled frontier" payoff that motivates ADR-0024
  Phase 2. Remains the safe fallback if S5 never passes.
- **PTQ-only ternary (CAT-Q/TWLA), skip QAT-distill.** Rejected as default (quality risk on a
  general artifact), retained as the S0 fallback when QAT compute is unavailable.
- **Native ternary pretraining from token one.** Deferred — belongs to ADR-0024 Phase 3 (train the
  frontier ternary), not to the distill-target decision; only worth it once the frontier is
  committed to ternary end-to-end.
- **Binary (1-bit).** Rejected — losing the `0` state removes feature-selection/sparsity and costs
  far more accuracy than 1.58-bit recovers (BWTA arXiv:2604.03957; the extra state is the point).
- **Port serving to bitnet.cpp for a turnkey ternary runtime.** Rejected — fixed-depth, no Q-exit,
  no mid-layer hidden states; violates ADR-0021 and ADR-0017. Kernel swap, not runtime port.

## Evidence

| Claim | Evidence | Class | Source |
|---|---|---|---|
| FP→ternary distillation recovers FP accuracy, 10× mem / 2.65× CPU, no from-scratch pretrain | BitDistill, arXiv:2510.13998 (full text fetched) | GROUNDED | external paper |
| Naive QAT-to-ternary unstable; gap grows 13.9→15.3 (0.6B→4B) | BitDistill §1 / Fig 1 | GROUNDED | external paper |
| GPU ternary kernels exist: BitNet W1.58A8 CUDA (dp4a) + spbitnet 2:4-sparse on consumer Ampere | microsoft/BitNet; github.com/Artemarius/spbitnet; BitNet b1.58 2B4T arXiv:2504.12285 | GROUNDED | web (opened) |
| Activation-outlier mitigations: Hadamard rotation / offset / outlier-channel-split | ITQ3_S arXiv:2603.27914; OffQ arXiv:2606.07116; Bit-by-Bit arXiv:2604.07888; TWLA arXiv:2606.13054 | GROUNDED | external papers |
| PTQ-ternary fallback exists (no QAT) | CAT-Q arXiv:2606.26650; TWLA arXiv:2606.13054 | GROUNDED | external papers |
| Residual ternary quality gap (naive 20–25% ppl) the recipe must close | HGF arXiv:2602.05269 | GROUNDED | external paper |
| 8GB box caps ~7B at Q4 (14B-Q4 offloads 34%→CPU, ~9× slower); ternary ~1.6 vs Q4 ~4 bits/wt | [[bigger-model-does-not-fit-8gb]] | MEASURED | in-repo research |
| Serving retains custom weight-tied recurrent loop + Q-exit + `output_hidden_states`; no engine serves adaptive-depth natively | [ADR-0021](0021-serving-substrate-retain-ouro-custom-loop.md); `scripts/ouro_serve.py` | HIGH | in-repo ADR |
| Σ_θ acceptance gate exists and gates weight updates on fresh holdout | [ADR-0025](0025-rlvr-dreaming-continual-updates-double-gated.md); #2226/#2237; `experiments/sigma_theta_abc/harness.py` | MEASURED | in-repo |
| Distill-to-≤8GB + D7 retention threshold is the open Phase-2 slot this fills | [ADR-0024](0024-sigma0-frontier-training-program.md) Phase 2 + D7 | HIGH | in-repo ADR |
| Mid-layer hidden state (probe/surprise monitor) must survive the format | [ADR-0017](0017-surprise-gated-decoding.md); AUROC 0.90–1.00 surviving 4-bit | HIGH | in-repo ADR |
