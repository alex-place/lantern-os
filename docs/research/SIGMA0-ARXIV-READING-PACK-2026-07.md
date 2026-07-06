---
title: Σ₀ verified arXiv reading pack
date: 2026-07-06
status: CURATED — papers verified against arXiv abstracts; not experimental evidence for Lantern OS
---

# Σ₀ verified arXiv reading pack — July 2026

## Purpose

This is a compact, **source-verified** reading pack for the next Lantern / Ouro work. It is tied to real open seams in this repository rather than a generic AI bibliography:

- **#2029:** measure Ouro's true one-step loop Jacobian, its spectral radius, and non-normal transient amplification.
- **#2033:** reproduce and evaluate the balanced honesty QLoRA on held-out items.
- The Collapse Certificate's explicit scope: it certifies a **local linear Jacobian**, not a global guarantee; its operational trigger and early-warning readout remain heuristics.

Every arXiv identifier and title below was checked against the arXiv abstract on **2026-07-06**. A paper is context, a baseline, or a candidate method — **never proof that a Σ₀ claim is true**.

## What the literature changes immediately

1. **Do not claim novelty for Jacobian spectral-radius regularization in a looped language model.** STARS already proposes it for LoopLMs. The research contribution must be narrower and more concrete: a measured, grounding-aware runtime certificate on the actual Ouro loop, with explicit evidence provenance and intervention outcomes.
2. **Do not infer contraction from a trajectory-ratio proxy alone.** The relevant measurements are both `ρ(J)` and `||J||₂`: a loop may have `ρ(J) < 1` while still exhibiting transient amplification when it is non-normal.
3. **Do not call the four-way answerability taxonomy established by these papers.** The literature supports abstention-aware objectives and evaluations; it does not establish Lantern's exact `grounded / seam-open / pin / refuted` taxonomy or prove its soundness.
4. **Do not turn a local certificate into a global or nonlinear theorem by citation.** Barrier / reach-avoid papers suggest possible methods, but any proof still needs a defined state abstraction, verified bounds, and a proof for that abstraction.

## Priority map

| Priority | Repository decision | What to read | Concrete outcome |
|---|---|---|---|
| **P0** | #2029 true Ouro-loop Jacobian | STARS; switched-system Lyapunov results | Measure `ρ(J)` and `||J||₂` with JVP/VJP power iteration; report uncertainty and input distribution. |
| **P0** | #2033 honesty QLoRA | Hallucination Tax; TruthRL; AbstentionBench; RL from Knowledge Feedback | Evaluate exact-answer correctness, hallucination, justified abstention, and over-abstention separately on the held-out set. |
| **P1** | prospective next base | Ouro; MoEUT; UT; fine-grained MoE; SwitchHead | Decide whether shared-depth recurrence or sparse routing earns its implementation cost on local hardware. |
| **P1** | certificate beyond local linear regime | neural barriers; scalable neural-CBF verification; reach-while-avoid | Write an explicit abstraction and a bounded-region objective before attempting any new theorem. |

---

## P0 — actual loop dynamics and non-normality

### 1. STARS — direct external baseline

- **arXiv:2605.26733** — Xiao-Wen Yang et al., [*Stabilizing Recurrent Dynamics for Test-Time Scalable Latent Reasoning in Looped Language Models*](https://arxiv.org/abs/2605.26733) (2026).
- **What it establishes:** LoopLM performance may peak and then degrade as recurrence depth grows; the paper proposes Jacobian spectral-radius regularization plus random loop sampling to drive latent states toward asymptotically stable fixed points.
- **Use in Lantern:** Treat it as the direct baseline for #2029. First measure the real Ouro map `h -> f(h)` before proposing regularization. Compare at least: observed trajectory ratio, `ρ(J)`, and `||J||₂` across prompts, loop depths, and routing regimes.
- **Limit:** This does **not** validate Σ₀'s covariance-floor operator, grounding semantics, or any claim about truthful answers.

### 2. Switched-system stability — only if routing produces regimes

- **arXiv:2405.03560** — Matteo Della Rossa and Aneel Tanwani, [*Converse Lyapunov Results for Stability of Switched Systems with Average Dwell-Time*](https://arxiv.org/abs/2405.03560) (2024).
- **What it establishes:** Stability for switched nonlinear systems can be characterized under average dwell-time with multiple Lyapunov functions.
- **Use in Lantern:** Relevant only if an MoE/router produces a sequence of materially different maps across loop steps. Record expert/routing state; then test whether an empirical dwell-time / switching assumption is even plausible.
- **Limit:** It is a control-theory bridge, not a proof that token-conditioned MoE routing satisfies its assumptions.

### Required #2029 measurements

For a sampled prompt distribution `D` and loop depth `t`:

```text
J_t = ∂f(h_t, context) / ∂h_t
measure: ρ(J_t), ||J_t||₂, non-normality gap ||J_t||₂ - ρ(J_t)
report: quantiles by prompt class, loop index, and any routing regime
```

A result should be labelled **MEASURED**, not **PROVEN**. `ρ(J)<1` is a local asymptotic-stability indicator; `||J||₂>1` can still allow finite-horizon transient growth.

---

## P0 — honesty, abstention, and the #2033 tune

### 3. Hallucination Tax — training regression to guard against

- **arXiv:2505.13988** — Linxin Song, Taiwei Shi, and Jieyu Zhao, [*The Hallucination Tax of Reinforcement Finetuning*](https://arxiv.org/abs/2505.13988) (2025).
- **What it establishes:** In the paper's setting, reinforcement fine-tuning reduces refusal on unanswerable questions; mixing in a small unanswerable set restores appropriate refusal with limited loss on solvable tasks.
- **Use in Lantern:** The balanced 137-row QLoRA corpus must measure the full tradeoff rather than accuracy alone. Preserve a held-out unknown / false-premise / insufficient-evidence slice.

### 4. TruthRL — direct ternary-reward baseline

- **arXiv:2509.25760** — Zhepei Wei et al., [*TruthRL: Incentivizing Truthful LLMs via Reinforcement Learning*](https://arxiv.org/abs/2509.25760) (2025).
- **What it establishes:** A ternary reward distinguishes correct answers, hallucinations, and abstentions, balancing truthfulness and answer rate in the authors' benchmark settings.
- **Use in Lantern:** This is the closest external baseline for the proposed three-way evaluation. Use its conceptual split for metrics before considering any RL change. Do **not** equate ternary reward with the four evidence-class labels.

### 5. AbstentionBench — evaluate both under- and over-abstention

- **arXiv:2506.09038** — Polina Kirichenko et al., [*AbstentionBench: Reasoning LLMs Fail on Unanswerable Questions*](https://arxiv.org/abs/2506.09038) (2025).
- **What it establishes:** The benchmark spans unanswerable, underspecified, false-premise, subjective, and outdated queries; it reports that reasoning tuning can degrade abstention in its tests.
- **Use in Lantern:** Add the same categories to the evaluation ledger. Report precision, recall, and F1 for abstention **and** answer accuracy on answerable tasks.

### 6. RL from Knowledge Feedback — boundary-aware training prior art

- **arXiv:2403.18349** — Hongshen Xu et al., [*Rejection Improves Reliability: Training LLMs to Refuse Unknown Questions Using RL from Knowledge Feedback*](https://arxiv.org/abs/2403.18349) (2024).
- **What it establishes:** A reward model can be trained around a dynamically estimated knowledge boundary to improve refusal beyond a model's knowledge scope.
- **Use in Lantern:** Keep `grounded` separate from mere internal confidence: an answer can be internally likely but ungrounded for the present query.

### 7. Rewarding Doubt — proper-scoring-rule baseline

- **arXiv:2503.02623** — Paul Stangel et al., [*Rewarding Doubt: A Reinforcement Learning Approach to Calibrated Confidence Expression of Large Language Models*](https://arxiv.org/abs/2503.02623) (2025).
- **What it establishes:** A logarithmic scoring-rule objective can train confidence expression while penalizing both over- and under-confidence.
- **Use in Lantern:** Candidate baseline for calibration reporting, not an excuse to output false numerical confidence. Use only after #2033 has real held-out labels.

### 8. Why Language Models Hallucinate — objective-level explanation

- **arXiv:2509.04664** — Adam Tauman Kalai, Ofir Nachum, Santosh S. Vempala, and Edwin Zhang, [*Why Language Models Hallucinate*](https://arxiv.org/abs/2509.04664) (2025).
- **What it establishes:** It argues that training and evaluation often reward guessing over acknowledging uncertainty.
- **Use in Lantern:** Supports reporting `wrong answer`, `justified abstention`, and `unjustified abstention` as distinct cells in #2033 — not a single accuracy score.

---

## P1 — next-model architecture

### 9. Ouro — current-base context

- **arXiv:2510.25741** — Rui-Jie Zhu et al., [*Scaling Latent Reasoning via Looped Language Models*](https://arxiv.org/abs/2510.25741) (2025).
- **What it establishes:** Ouro pretrains latent looped language models using iterative latent computation and entropy-regularized depth allocation.
- **Use in Lantern:** The relevant base-paper context for the actual local Ouro serving path. Its claims must be reproduced locally before being treated as Lantern performance claims.

### 10. MoEUT — shared-depth recurrence with sparse capacity

- **arXiv:2405.16039** — Róbert Csordás et al., [*MoEUT: Mixture-of-Experts Universal Transformers*](https://arxiv.org/abs/2405.16039) (2024).
- **What it establishes:** Layer sharing plus MoE, layer grouping, and peri-layer normalization can make a Universal Transformer competitive with standard Transformer language models in the authors' experiments.
- **Use in Lantern:** Candidate architecture if a future model needs stronger parameter-to-compute ratio. Start with a minimal dense-loop baseline; add MoE only when an ablation shows sparse capacity solves an observed bottleneck.

### 11. Fine-grained MoE mechanism — correct citation

- **arXiv:2310.10837** — Róbert Csordás, Kazuki Irie, and Jürgen Schmidhuber, [*Approximating Two-Layer Feedforward Networks for Efficient Transformers*](https://arxiv.org/abs/2310.10837) (2023).
- **What it establishes:** A general framework for approximating two-layer feed-forward networks, including MoE-like methods; it studies parameter-equal comparisons.
- **Citation correction:** This is the paper sometimes casually labelled “σ-MoE” in prior notes. Its verified arXiv title is the one above; do not cite it as a paper titled “σ-MoE.”

### 12. SwitchHead — sparse attention candidate

- **arXiv:2312.07987** — Róbert Csordás et al., [*SwitchHead: Accelerating Transformers with Mixture-of-Experts Attention*](https://arxiv.org/abs/2312.07987) (2023).
- **What it establishes:** An attention-MoE method that reduces attention matrices and reports matched language-modeling performance in the authors' setting.
- **Use in Lantern:** Only after dense-loop profiling shows attention is the bottleneck; sparse attention makes the dynamics and verification problem harder.

### 13. Universal Transformers — foundational recurrence baseline

- **arXiv:1807.03819** — Mostafa Dehghani et al., [*Universal Transformers*](https://arxiv.org/abs/1807.03819) (2018).
- **What it establishes:** A self-attentive recurrent-in-depth architecture with optional dynamic per-position halting.
- **Use in Lantern:** Conceptual baseline for shared-depth recurrence. The ID is **1807.03819**, not `1707.01488`.

---

## P1 — beyond a local linear certificate

### 14. Set-based training of neural barrier certificates

- **arXiv:2605.02526** — Miriam Kranzlmüller et al., [*Set-Based Training of Neural Barrier Certificates for Safety Verification of Dynamical Systems*](https://arxiv.org/abs/2605.02526) (2026).
- **What it establishes:** A set-based loss designed so a zero loss formally establishes the specified barrier-certificate properties.
- **Use in Lantern:** A candidate methodology for a bounded **state abstraction** of the loop; not for an unbounded raw 2048-dimensional hidden state without a tractable domain and verification plan.

### 15. Scalable verification of neural control barrier functions

- **arXiv:2511.06341** — Nikolaus Vertovec et al., [*Scalable Verification of Neural Control Barrier Functions Using Linear Bound Propagation*](https://arxiv.org/abs/2511.06341) (2025).
- **What it establishes:** A bound-propagation verification framework for neural CBFs, including gradient bounds and refinement.
- **Use in Lantern:** A practical reference for what an actual verification pipeline must bound. The main question is whether a low-dimensional, semantically meaningful Σ₀ state can preserve the needed guarantee.

### 16. Cooperative reach-while-avoid certificates

- **arXiv:2601.20324** — Jingyuan Zhou, Haoze Wu, and Kaidi Yang, [*Neural Cooperative Reach-While-Avoid Certificates for Interconnected Systems*](https://arxiv.org/abs/2601.20324) (2026).
- **What it establishes:** Neural certificates for cooperative reach-while-avoid properties in interconnected systems, with an emphasis on scalability.
- **Use in Lantern:** Future reference for multi-agent / swarm work: reach a grounded state while avoiding degenerate or unsafe regions. It does not prove anything about a language-model council without a defined agent model.

---

## Existing certificate references — do not duplicate

The current certificate already cites the model-collapse / verification lineage:

- **arXiv:2402.07043** — *A Tale of Tails: Model Collapse as a Change of Scaling Laws*.
- **arXiv:2406.07515** — *Beyond Model Collapse: Scaling Up with Synthesized Data Requires Verification*.

Keep these in the certificate's lineage list; keep this document as the implementation-facing reading pack.

## First experiments, in order

1. **Measure before modifying Ouro.** Close #2029's `ρ(J)` and `||J||₂` measurement. No spectral penalty, no stability claim, and no architecture fork before this baseline exists.
2. **Run the #2033 held-out evaluation.** Report a four-cell confusion table: correct answer, wrong answer, justified abstention, unjustified abstention. Add confidence calibration only when labels exist.
3. **Decide whether routing is needed.** Compare dense-loop quality and throughput to a minimal MoEUT-inspired ablation. If no measured bottleneck is solved, do not add MoE.
4. **Write an abstraction contract before barrier work.** State variables, domain, unsafe set, grounding transition, and what a certificate would guarantee. Otherwise “global convergence” is only an aspiration.

## Claim discipline

| Claim | Allowed status now |
|---|---|
| Σ₀ Theorem 1 / C3 scope | Follow the certificate's per-section labels and local-linear caveat. |
| Ouro loop is locally contractive | **Unmeasured** until #2029 uses JVP/VJP on the actual serving model. |
| Spectral regularization helps LoopLMs | **Established prior art in STARS' reported experiments; unreplicated in Lantern.** |
| The QLoRA improves honesty | **Unmeasured** until #2033 held-out results exist. |
| Answerability taxonomy is novel or sound | **Unestablished.** Requires a literature review and a defined soundness theorem. |
| Barrier methods prove global Σ₀ safety | **Unestablished.** Requires a verified model and region, not citations. |
