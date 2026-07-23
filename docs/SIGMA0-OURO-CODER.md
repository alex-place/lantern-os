---
author: Alex Place, with the unisona.ai agent lanes
created: 2026-06-19
updated: 2026-07-23
status: Public whitepaper — the Σ₀ from-scratch model program (operator direction 2026-07-23).
  Prior revisions of this page (the retrofit-era lineage SSOT) are preserved in git history;
  internal engineering twins: research/2026-07-23-sigma0-llm-design.md (design of record),
  research/2026-07-23-sigma0-rc1-model-spec.md (baseline harness), SIGMA0-COLLAPSE-CERTIFICATE.md.
---

# Σ₀ — A Verified Looped Language Model, Built From Scratch

**A whitepaper on a small language model designed to be owned, not rented: trained from
scratch for verifiable work, stable by construction, honest by contract, and small enough to
run on the computer you already have.**

---

## Abstract

Frontier language models buy capability with scale: hundreds of billions of parameters,
trillions of training tokens, datacenter serving. Σ₀ ("Sigma-Zero") is a bet on the opposite
corner of the design space: a **~1.5B-parameter, weight-tied *looped* transformer, trained
from scratch as a specialist in verifiable work** (code, mathematics, structured reasoning),
where an **external execution verifier — not the model's own opinion — is the ground truth**
at every stage: data selection, training reward, checkpoint promotion, and inference-time
acceptance. The model reuses one shared block recursively (depth, not width, as the scaling
axis), is regularized during training for provable loop stability, carries a trained
abstention signal ("I cannot verify this"), and targets a CPU-viable ≤4GB serving footprint
with a ternary-precision path. We state every claim with its evidence class, publish the
kill-criteria that would falsify the program, and estimate the full from-scratch training
cost at an order of magnitude accessible outside the frontier labs. Σ₀ does not compete with
frontier models on breadth. It competes on **verified correct answers per dollar on local
hardware** — a measurable frontier where small, careful, and honest can win.

## 1. Motivation

Three observations drive the design:

1. **Test-time computation can beat parameter count.** A small model that searches under a
   reliable verifier can outperform a much larger model answering once (Snell et al., 2024,
   arXiv:2408.03314). The catch: the verifier must be exact and cheap.
2. **Code and math have a free, exact verifier — the execution environment.** A test passes
   or it doesn't. This is the one domain where a small model cannot bluff and a large model
   holds no monopoly on truth.
3. **Generalization comes from verification, not scale.** Small recursive models have
   already reached public reasoning leaderboards, and the analysis of those systems (ARC
   Prize, 2025) shows their gains come from iterative refinement — while their failures come
   from memorizing instead of generalizing, precisely when the halt signal is *learned*
   rather than *checked*. We reproduced this failure on a real execution run: a memorizing
   program passed **every** visible test and failed the held-out one. Σ₀'s answer is
   architectural: the verifier is external, and held-out checks are mandatory.

The product thesis follows: for a user with an ordinary computer, **no system should deliver
more verified-correct answers per dollar per day** — locally, privately, offline.

## 2. Design principles

1. **The verifier never moves inside.** Execution results gate everything; internal
   confidence signals are alarms, never judges (our measured "Freshness Law":
   self-assessment cannot substitute for fresh external tests).
2. **Depth over width.** Capability scales by re-applying one shared block (looping), not by
   adding parameters. Loop depth is a *dial the user's budget controls*.
3. **Stability is a contract, not a hope.** Looped models exhibit peak-then-collapse under
   depth. Σ₀ trains against a spectral-stability regularizer and serves behind a
   spectral-radius acceptance gate (ρ(J) < 1), with a proven anti-freeze operator armed
   under a bounded budget. (Machinery: our Collapse Certificate — theorems proven in-regime
   and machine-checked; scope stated there honestly.)
4. **Honesty is a capability.** A trained abstention head, supervised by verifier outcomes,
   makes "I cannot verify this" a first-class output. Precision-of-claimed-solve ≈ 1.0 is a
   headline metric, not a footnote.
5. **Small enough to own.** ≤4GB, CPU-viable, offline-first. If it needs a datacenter, it
   has failed the mission.

## 3. Architecture

| Component | Specification | Rationale / source |
|---|---|---|
| Core | **weight-tied looped transformer**, one shared block of ~8 layers, recursion R ∈ 2–8 | depth as the third scaling axis (Ouro, arXiv:2510.25741); elastic-depth training with short/long-unroll consistency (arXiv:2602.11451) |
| Parameters | **~1.5B** (product tier ≤3B hard ceiling) | smallest tier with a measured usable truth signal (probe AUROC 0.980/0.774 at 1.5B-class; 0.5B fails) |
| Exit / halt | learned early-exit **calibrated against the external verifier** during training | the ARC lesson: a purely learned halt memorizes; a verifier-calibrated one generalizes (design bet, falsifiable) |
| Attention | GQA + QK-Norm baseline; **static 3:1 hybrid linear-attention variant** (Gated-DeltaNet class) for long-context/CPU | the 2026 mainstream (Qwen3.5 promoted the hybrid to flagship); *static* layer patterns are certifiable by our stability machinery — unlike input-routed MoE |
| Positional | RoPE + NoPE mix on the sliding pattern | current small-model best practice (SmolLM3, Cohere-class recipes) |
| **Excluded: MoE** | no mixture-of-experts in v1 | routed recurrent loops are *switched systems* our certificate does not yet cover; a named admission gate (dwell-time certification) must exist first — deferred, not rejected |
| Auxiliary objective | multi-token prediction head | native self-speculative serving (draft-free speedup on CPU) |
| Precision | bf16 from-scratch run → **quantization-aware ternary W1.58A8** (BitNet-class) as the serving artifact | the only published route to 7B-class capability in ~2GB with CPU-native kernels; probe-survival is the acceptance test |
| Tokenizer | own ~64k BPE trained on the specialist corpus | from-scratch means the whole stack (nanochat/CS336 pattern) |
| Context | 8k at pretrain → 32k staged extension | task window for verified coding work |

## 4. Training program — from scratch, honestly costed

**The wedge that makes from-scratch feasible:** we are not training an 11-trillion-token
generalist (SmolLM3's bill for a competitive general 3B). We are training a **specialist**
whose corpus is dominated by *verifiable* material — code with tests, mathematics with
checkable answers, structured reasoning traces that passed execution. The core bet
(**UNPROVEN, falsifiable at pilot scale**): verifier-filtered specialist data + depth
recursion buys more verified capability per token than generalist breadth.

- **Data (~500B–1T tokens, staged):** permissively-licensed code/math corpora (TACO
  Apache-2.0 as anchor; exec-verified subsets of open training sets; open web math/code
  slices à la Dolma 3), plus our own **escalation corpus** — frontier-teacher solutions to
  problems our earlier small tiers failed, each one execution-verified. Selection is
  **utility-matched, not quality-maxed**: high-perfection teacher traces measurably impair
  small students (the Quality-Utility Paradox, arXiv:2606.16152 — independently confirming
  our own measured negative). Test suites used in training are **mutation-hardened** (weak
  tests admit false solves; mutation feedback lifts test discrimination 53%→89.5%,
  arXiv:2501.12862).
- **Objectives:** cross-entropy + **JSRR spectral-stability regularizer** (STARS,
  arXiv:2605.26733) + multi-token-prediction auxiliary; then **RL from verifiable rewards**
  where the reward is the executed **Fix-Rate** (fraction of failing tests a step turns
  green, regression-penalized); then ternary distillation.
- **Promotion discipline:** no checkpoint replaces another without passing the **Σ_θ
  acceptance gate** on *fresh held-out* verified tasks — self-checks can spot disasters;
  only fresh outside tests may pick winners.
- **Cost (PREDICTED, order-of-magnitude, ±2×):** 6·N·D·R̄ with N=1.5B, D=1T, mean unroll
  R̄≈3 ⇒ ~2.7×10²² FLOPs ≈ **20–30k H100-hours ≈ $50–150k** for the full run — outside
  hobby range, inside indie range, and staged so most of the risk is retired for thousands,
  not tens of thousands:
  **G0** nanochat-scale dry run of the full pipeline (~$10²) →
  **G1** ~130M-parameter looped pilot on the specialist mix (~$10³): the go/no-go
  measurement for the specialist bet and the verifier-calibrated halt →
  **G2** the 1.5B run (funded decision, gated on G1) →
  **G3** ternary artifact + probe-survival acceptance.

## 5. What carries over from our measured groundwork

This program does not start from zero evidence. Already measured on our hardware and
codebase (evidence class MEASURED unless noted): execution-verified cascade economics (a
strong cheap tier escalates ≈0% of steps at 8.3× lower cost; weak-tier + frontier rescue
88.4% > 84.8%); an internal truth-signal probe clearing the useful bar at the 1.5B tier;
dose-response curves for distilling verified traces into small models (small aggressive doses
*hurt*; gentle + retention holds parity — the from-scratch data rules encode these lessons);
the collapse-prevention operator at 100% over 900 forced-collapse runs (synthetic regime;
PROVEN anti-freeze theorem in-regime); and the JSRR acceptance gate machine-checked on
known-spectrum cases. The verified-cascade harness itself is retained — **not as the
product, but as the teacher-and-examiner infrastructure** that generates Σ₀'s hardest
training data and grades its checkpoints.

## 6. Evaluation and falsifiers (pre-registered)

Headline metric: **verified pass@1 per dollar on reference consumer hardware**, with
precision-of-claimed-solve reported alongside. Registered runs: HumanEval-164 under the
verified protocol (held-out scoring); MBPP held-out; ARC-AGI-2 *budgeted* track (the
cost-efficiency band, ~$0.20/task class — explicitly not the $10–$200 frontier cluster);
depth-stability sweeps (accuracy and ρ trajectory vs. loop depth). Kill criteria: if
verifier-guided refinement cannot beat equal-compute blind sampling, the thesis fails; if
the G1 pilot shows the specialist mix cannot outperform a retrofit baseline at matched
compute, **the from-scratch program stops and says so** — the retrofit path remains the
fallback, and the measurement stands either way.

## 7. Positioning

| Against | Their strength | Σ₀'s differentiation |
|---|---|---|
| Frontier cloud models | breadth, peak capability | verified answers/$ locally; privacy; offline; honesty contract |
| Small open dense models (Qwen/Phi/Gemma class) | strong single-shot baselines | looping + verifier amplification + stability/abstention machinery around a comparable parameter budget |
| Looped research models (Ouro/HRM/TRM) | the same depth bet, at research maturity | external-verifier halt (vs. learned/memorizing halt), stability-gated serving, a product envelope, and full training-provenance discipline |
| Diffusion code models (Mercury class) | raw parallel throughput | orthogonal; a candidate future proposer inside the same verified protocol |

Transparency reference: OLMo 3 (AI2) sets the bar for reproducible training releases; Σ₀
adopts the same posture at its scale — data recipes, training code, checkpoints, and the
evidence ledger for every claim in this paper.

## 8. Claims discipline

Every Σ₀ statement carries one of five classes — **PROVEN** (theorem, machine-checked,
scope stated) · **MEASURED** (a run you can re-execute) · **IMPORTED** (external result,
cited, not re-verified) · **PREDICTED** (calculation ahead of measurement) · **UNPROVEN
BET** (the honest name for the parts that make this a research program). The two bets that
matter: the specialist-data wedge (§4) and the verifier-calibrated halt (§3). Both die or
survive at G1 for roughly the cost of a used car — which is the point of the staging.

## 9. Lineage

Σ₀ stands on a year of prior local-model work: a QLoRA'd 3B coder (retired), the Ouro-1.4B
looped kernel (the recursion substrate and serving stack), an owned parallel-loop
transformer, a verified Qwen-7B tier (now the escalation reference), and the Spiral
verified-cascade harness (now the teacher/examiner). The full engineering history of each
era is preserved in this file's git history and the internal design docs. An ADR formalizing
the from-scratch program (G0–G3, budget gates) follows operator approval.

---

*unisona.ai / Lantern OS — 2026-07-23. Corrections welcome: every number above is either
reproducible from this repository or marked as a bet.*
