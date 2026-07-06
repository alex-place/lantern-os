# ADR-0023: Σ₀ frontier training program — honesty-native pretraining

- Status: **Proposed** (requires Alex's explicit acceptance; agents may not flip this)
- Relates to: [ADR-0011](0011-proprietary-sigma0-base-model.md) (own Σ₀ base), [ADR-0015](0015-qwen-teacher-verified-distillation.md) (verified distillation), [ADR-0021](0021-serving-substrate-retain-ouro-custom-loop.md) (serving substrate)
- Briefs: [SIGMA0-FRONTIER-TRAIN-BRIEF.md](../SIGMA0-FRONTIER-TRAIN-BRIEF.md) (this program) · [SIGMA0-MODEL-DESIGN-BRIEF.md](../SIGMA0-MODEL-DESIGN-BRIEF.md) (serving layer / distillation target)

## Context

The operator has directed that training a frontier model is in scope; budget is a decision
input, not an assumed constraint (2026-07-06). The evidence base assembled this cycle:

1. **The axis is open.** Hallucination persists because 0-1-scored evals reward guessing
   (Kalai et al., arXiv:2509.04664, MEASURED-framework); incumbents are benchmark-locked
   into that objective. Post-training honesty patches exist (TruthRL arXiv:2509.25760,
   R-Tuning arXiv:2311.09677); **honesty-native pretraining at scale does not** (7 verified
   searches, 2026-07-06). A new program can adopt abstention-aware proper scoring from
   token one.
2. **The property is trainable and measurable small.** Our QLoRA honesty-tune of
   Ouro-1.4B: golden 0.958 / confab 10% / over-abstain 2.2% on 66 held-out — ties
   GPT-4o-mini on golden, beats Gemini-2.5-Flash on confabulation (MEASURED,
   `experiments/sigma0_ouro_honesty_eval.py`). Known failure modes: corpus imbalance
   collapses to always-assert (MEASURED); RFT erodes abstention (arXiv:2505.13988).
3. **The architecture family scales.** Ouro pretrained recurrent-depth to 7.7T tokens
   (arXiv:2510.25741); MoEUT made shared-layer UTs parameter- and compute-competitive to 1B
   (arXiv:2405.16039). Learned halting is the weak leg (MoEUT's ACT ablation + our Q-exit
   nulls, both MEASURED) — depth control moves to policy.
4. **The certificate becomes the training spec.** Measured loop quantities (ρ≈0.88,
   machine-checked ROA #1991, grounding-deadline §3.1), STARS-style stability
   regularization (arXiv:2605.26733), switched-system dwell-time constraints for MoE
   routing (arXiv:2405.03560), and trainable-with-proof barrier certificates
   (arXiv:2605.02526) collectively define training-time instrumentation and abort criteria.
5. **The risk that scales with capability is §7.2** — a trained gamer, honest under audit
   only (alignment faking measured at frontier: arXiv:2412.14093). Anti-gaming bindings are
   a first-class requirement, not post-hoc.

## Decision (proposed)

Run a **phased, kill-gated training program** for an honesty-native pretrained model
("frontier on the honesty axis; capability-competitive at its scale"), under the two-layer
contract **train frontier → distill to the ≤8GB local serving artifact**:

- **Phase 0 — Design.** Both briefs executed at max reasoning effort; decisions D1–D8
  resolved with falsifiers; this ADR accepted. *Gate: operator accepts D1 scale/budget tier.*
- **Phase 1 — PILOT.** MoEUT-scale replication (order 100M–1B params, small token budget)
  **with the honesty objective stack** (abstention-aware proper scoring + balanced-negative
  data + STARS regularization + certificate instrumentation). *Gate: pilot beats
  CE-only control on confabulation-rate at equal golden accuracy, and training-time
  certification (ρ tracking, abort criteria) demonstrably works. Fail → stop; the thesis
  is refuted cheaply.*
- **Phase 2 — BASE.** 1–3B at a real token budget; distillation to the serving artifact;
  external marks (AbstentionBench, SimpleQA-Verified, HaluEval). *Gate: honesty property
  survives distillation (retention threshold set in D7) and the watched-vs-unwatched gap
  is measured and bounded.*
- **Phase 3 — FRONTIER tier.** Scale per D1, only through the prior gates.

Program invariants: evidence-classed claims with artifacts; GPU-hour anchors only (no
invented prices); every phase has a kill-gate; honesty bound to external checks the model
does not control; one loop, no sprawl; operator authority over every gate.

## Consequences

- **Positive:** first-mover on the one axis incumbents are structurally locked out of;
  the certificate machinery gains its natural role (training-time spec); the serving layer
  inherits a base whose defining property is the product's promise; every phase is cheap to
  stop relative to the next.
- **Negative / risks:** pretraining programs are capital- and ops-intensive at Phase 2+;
  MoE/UT kernels are immature (1.5–2× wall-clock today, MEASURED); "honest negatives at
  pretraining scale" (D5) is an unsolved data problem and may be the real bottleneck;
  §7.2 gaming risk grows with capability and is never fully closed — only bounded by
  binding and unannounced probes.
- **Explicitly rejected:** raw-capability leaderboard chasing; learned-exit depth (twice
  measured weak); honesty as marker-emission; any phase advance without its gate.

## Open questions (to be resolved by the briefs, not asserted here)

D1 tiers and cluster shape; dense-recurrent vs MoE-UT (D2); the exact objective staging
(D4); the honest-negative data pipeline at scale (D5); distillation retention threshold (D7).
