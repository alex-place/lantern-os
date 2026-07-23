---
title: "Σ₀: Small-Model Reasoning via Persistent Test-Time Verification"
authors: Alex Place, with the unisona.ai agent lanes
affiliation: unisona.ai / Lantern OS
date: 2026-07-23
status: DRAFT technical report — not peer-reviewed, no venue. Evidence-classed throughout;
  claims marked PROVEN (machine-checked, in-regime) / MEASURED (reproducible run) /
  IMPORTED (external result, cited) / ADOPTED (external method used wholesale) /
  PREDICTED (calculation ahead of measurement) / DESIGNED-BET (specified, unbuilt, falsifiable).
companion-docs: SIGMA0-OURO-CODER.md (whitepaper), research/2026-07-23-sigma0-llm-design.md
  (design of record), research/2026-07-23-sigma0-rc1-model-spec.md (baseline harness),
  SIGMA0-COLLAPSE-CERTIFICATE.md (stability proofs).
---

# Σ₀: Small-Model Reasoning via Persistent Test-Time Verification

## Abstract

We describe **Σ₀**, a program to build a small (~1.5B-parameter) local language model that
reaches useful capability on *verifiable* work — code, mathematics, and market analysis — not
by scaling parameters but by **persistent test-time verification**. Σ₀'s core is a weight-tied
*looped* transformer whose inference procedure, the **Spiral**, proposes a candidate, checks it
against an *external* verifier (execution), and retries — deeper or from a new angle —
escalating a stuck step to a larger model rather than abstaining, until the verifier confirms
an answer or a per-task budget is exhausted. An external verifier is the ground truth at every
stage: data selection, training reward, checkpoint promotion, and inference acceptance. We
report measured results for the *system* components on our hardware — an execution-verified
cascade that is 8.3× cheaper than an always-large-model policy at near-zero escalation; a
hidden-state truth-signal probe measured at AUROC 0.994 on our 1.4B looped model (length-matched
set, well above a 0.77 logprob baseline); a machine-checked spectral-stability
acceptance gate; and a reproduced failure mode (a memorizing program passing every visible test
and failing a held-out one) that motivates mandatory held-out verification. We give the
from-scratch training program, its staged go/no-go gates, and an order-of-magnitude cost
estimate. We are explicit that the trained model itself, its ternary serving artifact, and the
headline verified-cascade benchmark are **not yet measured** — the paper's purpose is to state
the design, the evidence for its components, and the falsifiers that would end the program.

## 1. Introduction

Frontier language models buy capability with scale: 10¹¹–10¹² parameters, ~10¹³ training tokens,
datacenter serving. This purchases breadth but excludes the user who wants a capable assistant
that runs **on their own hardware, offline, and private**, and it decouples the model's fluency
from any guarantee of correctness. Σ₀ occupies the opposite corner and accepts its costs.

Three premises (§2 situates them in the literature):

- **P1 — test-time compute can substitute for parameters.** A small model that searches under a
  reliable verifier can exceed a larger model answering once [Snell 2024]. The precondition is a
  verifier that is *exact and cheap*.
- **P2 — some domains supply exactly that verifier.** Code and mathematics are checkable by
  execution: a test passes or it does not. This is the one setting where a small model cannot
  bluff and a large model holds no monopoly on truth.
- **P3 — small recursive models gain from iterative refinement, and fail by memorization when the
  halt is *learned*.** Analyses of small recursive systems on reasoning benchmarks attribute their
  gains to iterative refinement (not scale) and their failures to *memorization*, specifically when
  the halt/accept signal is learned rather than checked [ARC Prize 2025]. Σ₀'s own hypothesis —
  that an *external verifier* is what converts refinement into generalization — is a DESIGNED-BET,
  not this imported finding; we reproduce the memorization failure directly (§7.4) as its
  motivation.

**Contributions.**
1. A design (§3–§6) unifying a looped small model, an external-verifier inference loop with
   escalation, a machine-checked stability contract, and a from-scratch specialist-training
   program — with each component's evidence class stated.
2. Measured results (§7) for the *system* components on commodity hardware, including cascade
   economics, an internal-truth probe, an anti-collapse operator, and a reproduced
   memorization failure that we convert into a design requirement (held-out verification).
3. An honest cost model and staged go/no-go plan (§6.4) that retires the two load-bearing bets
   for ~10³ dollars before committing ~10⁵.
4. A generalization of the method to a delayed-verifier domain, **trading** (§8), where the
   object of convergence is *"is there a provable edge"* rather than the future outcome.

**Non-claims.** Σ₀ does not target frontier breadth, open-ended creative work, or peak
leaderboard scores at any cost. Its measurable frontier is *verified correct answers per dollar
on local hardware*.

## 2. Related work

**Test-time compute and verification.** Scaling inference-time computation can be more effective
than scaling parameters [Snell 2024]; verifier-guided sampling and process-reward models exploit
this [pass@k, Chen 2021; Lightman 2023]. Σ₀ takes the strong form: the verifier is *execution*,
not a learned reward model, and it gates acceptance rather than merely reranking.

**Looped / recurrent-depth models.** Reusing a weight-tied block R times is a scaling axis
distinct from width [Ouro/LoopLM, 2510.25741; Universal Transformers, 1807.03819]; recent work adds
adaptive per-token recursion [Mixture-of-Recursions, 2507.10524], elastic-depth training
[LoopFormer, 2602.11451], and retrofitting recurrence onto pretrained models [2511.07384]. Σ₀
adopts the looped core and, critically, replaces the *learned* halt with a verifier-calibrated
one (§3, §7.4).

**Cascades and routing.** Cheap-first, escalate-on-difficulty cascades match a strong model at a
fraction of cost [FrugalGPT, 2305.05176; model-cascading-for-code, 2405.15842]. Σ₀'s escalation
is gated by *execution outcome*, not a confidence heuristic, and inherits partial progress.

**Stability of recurrent inference.** Looped LMs exhibit peak-then-collapse under depth; Jacobian
spectral-radius regularization (ρ<1) stabilizes them [STARS, 2605.26733; CART, 2606.01495].
Σ₀ adopts ρ<1 as a machine-checked acceptance gate and adds a proven anti-freeze operator (§5).

**Efficient serving.** Ternary (1.58-bit) training and distillation put larger effective capacity
in small memory with CPU-native kernels [TernaryLM, 2602.07374; BitNet-Distillation, 2510.13998].
Static hybrid linear attention (Gated-DeltaNet class) is now mainstream and, being input-*static*,
is compatible with §5's per-layer stability analysis — unlike input-routed MoE (the frontier
default, e.g. DeepSeek-V3 [2412.19437]), which is a switched system our stability machinery does
not yet cover.

**Positioning.** We know of no prior *design* that combines a looped small core, an
execution-verifier inference loop with progress-inheriting escalation, a machine-checked
stability gate, and mandatory held-out verification, within a *targeted* CPU-viable envelope —
though whether the integrated system actually holds inside that envelope is precisely what G1–G3
test (§6.4, §7.1). The individual components are all prior art; we claim their *integration and
evidence discipline*, not new mathematics (§9).

## 3. Architecture

The core is a **weight-tied looped transformer**: one shared block of ~8 layers, applied
recursively R ∈ [2,8] times, with a prelude and coda. Capacity scales by re-applying the block
(depth), keeping unique parameters at ~1.5B (product-tier ceiling ≤3B). Design details
(IMPORTED unless noted):

| Component | Choice | Basis |
|---|---|---|
| Recursion | weight-tied shared block, R∈[2,8] | Ouro 2510.25741; MoR 2507.10524 |
| Halt | early-exit **calibrated against the external verifier** in training | our answer to the learned-halt memorization failure (§7.4) — **BET** |
| Attention | GQA + QK-Norm; static 3:1 hybrid linear-attention variant for long context | Qwen3.5-class practice; static ⇒ §5-certifiable |
| Positional | RoPE + NoPE on the sliding pattern | small-model best practice |
| **Excluded (v1)** | mixture-of-experts | routed recurrent loops are *switched systems* outside §5's current scope; deferred behind a dwell-time admission gate, not rejected |
| Aux objective | multi-token prediction | draft-free self-speculative serving |
| Precision | bf16 pretrain → QAT **ternary W1.58A8** serving artifact | TernaryLM; BitNet-Distillation |
| Footprint | ≤4GB, CPU-viable, offline | product constraint |

## 4. The Spiral: persistent verified inference

Σ₀'s inference procedure is defined by persistence toward a *verified* answer, not by a single
pass:

1. **Propose** a candidate (N samples, sequential with early-stop-on-verify; min-p sampling).
2. **Verify** by execution against tests, with a mandatory **held-out** split: the visible tests
   drive selection, held-out tests decide the *scored* verdict (§7.4).
3. **Refine** on failure — deeper recursion or a new candidate — committing only steps that
   provably advance (increase the fraction of failing tests now passing, regression-penalized).
4. **Escalate** a stalled step to a larger tier (local first, cloud rarely), *carrying the best
   candidate and the failing tests*, then re-verify. Escalation inherits progress; it does not
   restart.
5. **Halt** on one of three: **verified** (goal), **budget** (an anytime dial the user sets), or
   **honest halt** ("I cannot verify this"), which fires only after loop, escalation, and budget
   are all exhausted.

**Why the verifier is load-bearing.** Persistence without an external checker does not converge
on truth — it converges on a self-consistent fixed point (representational collapse; §5). The
verifier is what tells the loop it has *arrived*; it is simultaneously the objective and the
brake. Abstention is therefore the rare *earned* floor, not the default behavior — which is what
makes it trustworthy when it occurs.

## 5. Stability: the Collapse Certificate

Looped inference risks two pathologies under depth — divergence and collapse-onto-a-frozen-state.
Σ₀'s stability machinery (full proofs and honest scope in the companion certificate) provides:

- **A collapse theorem (PROVEN, in-regime, machine-checked).** For the linearized recurrent map,
  an ungrounded system contracts onto a null manifold (collapse) or diverges, with no benign
  third fate; the symmetric/normal case is proven, and the non-normal *drift* case is resolved by
  a spectral (Riesz) dichotomy. "Machine-checked" means closed-form algebra + numerical sweeps +
  unit tests, **not** a formal (Lean) proof; every theorem certifies the local Jacobian, so
  grounding remains the actual safety mechanism.
- **A discrete acceptance gate (ADOPTED, machine-checked verdict).** The serve loop accepts a
  generation only if the empirical-Jacobian spectral radius ρ(A) < 1 − margin (JSRR, from STARS).
  Validated on 12 synthetic operators of known spectrum. Honest scope: what is checked is the
  *verdict*, not that ρ<1 improves quality — CART reports a null quality result for a learned
  stability gate, so ρ<1 is validated as the right stability *object*, not a win; and the gate
  runs on an empirical-Jacobian proxy, not the true JVP.
- **An anti-freeze operator (PROVEN anti-freeze, MEASURED prevention).** A proximity-gated
  covariance re-excitation prevents permanent freeze for all A (Theorem C3); empirically it
  suppressed collapse in 900/900 forced-collapse synthetic runs. In the live engine it defaults
  to observe-only; Σ₀ arms it under a bounded budget with receipts.

**Consequence for architecture.** These results hold per fixed computational graph. Input-routed
MoE makes the graph *switch*, which the current certificate does not cover — hence the v1 MoE
exclusion (§3) and the deferred admission gate. A *static* hybrid-attention pattern does not
switch and is therefore admissible.

## 6. Training program (from scratch)

### 6.1 The specialist wedge (BET)
We do not train an 11T-token generalist. We train a **specialist** whose corpus is dominated by
*verifiable* material. The load-bearing, unproven hypothesis: verifier-filtered specialist data +
depth recursion buys more verified capability per token than generalist breadth.

### 6.2 Data
~500B–1T tokens: permissively-licensed code/math (Apache-2.0 TACO as anchor; exec-verified open
subsets), open web math/code, plus our own **escalation corpus** — execution-verified
frontier-teacher solutions to problems our smaller tiers failed. Selection is **utility-matched,
not quality-maxed**: high-reward teacher traces measurably impair small students [Quality-Utility
Paradox, 2606.16152 — externally confirming our own measured negative, §7.3]. Training test-suites
are **mutation-hardened** (weak tests admit false solves; mutation feedback lifts test
discrimination from ~53% to ~89.5% [2501.12862]).

### 6.3 Objectives and gates
Cross-entropy + **JSRR stability regularizer** + multi-token-prediction auxiliary; then **RL from
verifiable rewards** with the executed Fix-Rate as reward; then ternary distillation. No
checkpoint is promoted without passing the **Σ_θ acceptance gate** on *fresh held-out* verified
tasks — self-checks can spot disasters, but only fresh outside tests may select winners. (Σ_θ's
logic is tested; it has never controlled a real training run — its first run is its first test.)

### 6.4 Cost (PREDICTED, ±2×) and staging
6·N·D·R̄ with N=1.5B, D=1T, R̄≈3 ⇒ ~2.7×10²² FLOPs ≈ 20–30k H100-hours ≈ **$50–150k** for the full
run — outside hobby range, inside indie range, and *staged so most risk is retired cheaply*:
**G0** nanochat-scale pipeline dry-run (~$10²) → **G1** ~130M looped pilot on the specialist mix
(~$10³: the go/no-go for the wedge and the verifier-calibrated halt) → **G2** the 1.5B run (a
funded decision, gated on G1) → **G3** ternary artifact + probe-survival acceptance.

### 6.5 Base-model options (the G1 bake-off)
Three arms at matched compute, all fed by the same verifier-gated data and graded by Σ_θ:
(A) true from-scratch random init; (B) **Ouro-1.4B warm-start** (Apache-2.0; recursion already
pretrained); (C) **Qwen2.5-Coder-1.5B + retrofit recurrence** (strong code priors, the measured
1.5B probe signal, tokenizer compatible with white-box KD). A hybrid, **"Qwen-Loop"** — Qwen
priors folded into a looped stack via relaxed recursive transformation with per-loop LoRA
[2410.20672] — is the presumptive favorite and collapses (B)/(C). The choice is made by the gate,
not by taste; a zero-cost prerequisite is measuring whether Ouro's hidden state carries the probe
signal Qwen's does.

## 7. Evaluation

### 7.1 What is and is not measured
All numbers below are MEASURED on our hardware for *system components*. The trained Σ₀ model, the
ternary artifact, and the headline verified-cascade benchmark are **not yet measured** (G1
pending). We register the target metric and the falsifiers rather than claim results we do not
have.

### 7.2 Cascade economics (MEASURED)
A strong cheap tier escalated ≈0% of steps at **8.3× lower cost** than an always-large policy; a
weak cheap tier with frontier rescue measured **88.4% vs 84.8%** (rescue is real); a fully-local
0.5B→7B cascade solved **18/18** on MBPP-basic at **6% escalation** (17/18 by the cheap tier); in
a separate 6-problem live run it solved **5/6** at 33% escalation and honestly reported the one it
could not solve (`rle`) rather than fabricating a pass. An internal exec-verified coding
gate measured **0.96 pass@1**. A 7B Q4 reference measured **0.829** on HumanEval-164 single-shot
(re-scoped as the *escalation-tier* reference, not the product model).

### 7.3 Small-model training sensitivities (MEASURED)
Two shortcuts were measured *harmful* to a 0.5B model: retrieval-as-few-shot (6/6 → 2/6 on
held-out DP problems — template contamination) and aggressive small-corpus fine-tuning (a −6
verified-pass delta at 63 traces; ±0 at 204 gentle). Both results shape §6.2's data rules and are
consistent with the external Quality-Utility Paradox.

### 7.4 The memorization failure and held-out verification (MEASURED)
On a real execution run, a program that memorizes the training input/output pairs passed **every
visible test** (verifier Fix-Rate 1.0 → "solved") yet failed the held-out pair. This reproduces
the transduction/memorization mode that afflicts learned-halt recursive models and converts it
into a hard design requirement: **wherever tests can be split, the scored verdict is on held-out
tests only.**

### 7.5 Stability (PROVEN in-regime / MEASURED)
The JSRR verdict is machine-checked on 12 known-spectrum operators; the anti-freeze operator
prevented collapse in 900/900 forced-collapse synthetic runs. A hidden-state truth probe on
**Ouro-1.4B-Thinking** measured AUROC **0.9939** on a length-matched clean true/false set
(length-confound AUROC 0.500 — i.e. real signal, not a surface artifact — vs a 0.767 logprob
baseline; `data/sigma0/hidden_probe_report.json`). The per-tier decomposition the product envelope
relies on — a de-glossed 1.5B figure (~0.98/0.77) and near-chance at 0.5B (~0.70) — is
**operator-reported (#2877), not yet independently committed**; the RC1 protocol includes a
per-tier probe sweep to promote it to MEASURED (or refute it). Honesty AUROC on the *degeneration*
axis remains explicitly unclaimed here (tracked as certificate #2236).

### 7.6 Registered falsifiers (the RC1 protocol)
Pinned, pre-registered: (1) HumanEval-164 under the verified-cascade protocol vs the 0.829
reference; (2) verifier-amplification check — does measured verified-pass track 1−(1−p)^N within
the false-accept band? (3) ARC-AGI-2 *budgeted* track (the cost-efficiency band, ~$0.20/task
class — explicitly not the $10–$200 frontier cluster); (4) depth-stability sweep (accuracy and ρ
vs recursion depth); (5) a **kill row** — if verifier-guided refinement cannot beat equal-compute
blind Best-of-N, the central claim (P1) is refuted at this tier and reported as such.

## 8. Application: a delayed-verifier domain (trading)

Verification generalizes past code to any domain where reality eventually grades the model.
Trading is the salient case, with one structural twist: **at decision time the verifier is in the
future** — the market has not resolved, so one cannot spiral-until-the-trade-wins. The Spiral
therefore runs on the checkable object, the *analysis*: it retries until it can either **ground an
edge in data** — first identify the settlement rule from data (e.g. a weather market settling on
`round(max METAR tmpf)`, matched 14/14 against venue prints, MEASURED), then quantify the
fee-adjusted, backtested advantage — or **prove there is no edge** (e.g. a 15-minute crypto market
that loses after fees, MEASURED). Because every call is scored against outcomes over
time (Brier/calibration on an append-only ledger), the system accrues a **calibrated track
record** — a property a single-pass assistant structurally lacks, because it never keeps score.
The product claim is not superior market intelligence; it is *being right on the record, private,
and able to prove or disprove an edge before capital is risked.*

## 9. Limitations and honest scope

- **The model is unbuilt.** §3's core, §6's trained weights, the ternary artifact, and every §7.6
  falsifier are DESIGNED/BET, not measured. The paper documents a program with evidenced
  components, not a finished result.
- **No novel mathematics is claimed.** Every mechanism is prior art; the contribution is
  integration and evidence discipline. The one genuinely open theoretical slot is a dwell-time
  stability certificate for *routed* recurrent loops (the MoE admission gate), which we have not
  built.
- **In-regime proofs only.** All stability theorems certify the local linear Jacobian; grounding,
  not the certificate, is the global safety mechanism.
- **Domain-bounded.** Σ₀ is scoped to verifiable work. On broad world knowledge, creative writing,
  and long context — where small models are documented to fail — it escalates or abstains, and the
  product must communicate this at onboarding or fail its users' expectations.
- **The wedge may not hold.** If G1 shows the specialist-from-scratch arm cannot beat a
  retrofit baseline at matched compute, the from-scratch program stops; the measurement stands
  and the retrofit path remains.

## 10. Conclusion

Σ₀ is a bet that for verifiable work, a small model that *keeps trying under an external checker*
can deliver more verified correct answers per dollar, locally and privately, than either a lone
small model or an expensive frontier call. The bet is decomposed into components with measured
support (cascade economics, an internal-truth probe, a stability gate, a reproduced memorization
failure) and two load-bearing unproven hypotheses (the specialist wedge, the verifier-calibrated
halt) that a ~$10³ pilot resolves before ~$10⁵ is committed. We publish the falsifiers that would
end the program because a design whose load-bearing claims cannot be refuted is not a research
program but a manifesto.

## References

Snell et al., *Scaling LLM Test-Time Compute Optimally…*, arXiv:2408.03314 · Chen et al.,
*Evaluating LLMs Trained on Code* (pass@k), arXiv:2107.03374 · Lightman et al., *Let's Verify Step
by Step*, arXiv:2305.20050 · Dehghani et al., *Universal Transformers*, arXiv:1807.03819 ·
Ouro/LoopLM, arXiv:2510.25741 · Mixture-of-Recursions, arXiv:2507.10524 ·
LoopFormer, arXiv:2602.11451 · Retrofitted Recurrence, arXiv:2511.07384 · Relaxed Recursive
Transformers, arXiv:2410.20672 · FrugalGPT, arXiv:2305.05176 · Model Cascading for Code,
arXiv:2405.15842 · STARS (JSRR), arXiv:2605.26733 · CART, arXiv:2606.01495 · TernaryLM,
arXiv:2602.07374 · BitNet-Distillation, arXiv:2510.13998 · Quality-Utility Paradox,
arXiv:2606.16152 · Mutation-guided test generation, arXiv:2501.12862 · ARC Prize 2025 Technical
Report, arXiv:2601.10904 · DeepSeek-V3, arXiv:2412.19437. Internal machinery and measurements:
SIGMA0-COLLAPSE-CERTIFICATE.md and the run ledgers cited therein; RC1 protocol in
research/2026-07-23-sigma0-rc1-model-spec.md.
