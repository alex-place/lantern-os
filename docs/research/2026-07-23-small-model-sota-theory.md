# Defining SOTA in a restricted space — the math, what's validated, what isn't

**Date:** 2026-07-23 · **Prompted by the operator's challenge:** *"you need to answer real basic
HumanEval and SWE benchmarks with a small model — how do you plan to define SOTA in such a
restricted space other than saying it can be honest? Have you actually done any math or
validations?"* This document is the answer, written for human evaluators. Every number carries its
source; every formula states what has and has not been checked against reality.

---

## 1. The claim we refuse to make, and the claim we make instead

**Refused:** "our ≤8GB system will top HumanEval/SWE-bench leaderboards." Unwinnable and already
conceded in [SIGMA0-OURO-CODER §2](../SIGMA0-OURO-CODER.md): open 32B-class models match closed
frontier on SWE-bench; parameters are not our axis.

**Made (falsifiable, Pareto form):** on the operating point
**⟨local ≤8GB, verified answers, deterministic serving, bounded cost⟩**, the system achieves a
**cost–reliability frontier no published system matches at equal local budget**: specifically,
(a) higher *verified* pass@1 than any single ≤8GB model call at ≤K× its cost, and (b) a
*precision-of-claimed-solve* near 1.0 (when it says "solved," tests pass) that leaderboard systems
do not report at all. SOTA-in-restriction = **best measured point on that frontier, registered in
[BENCHMARKS.md](../BENCHMARKS.md) against published baselines** — not a vibe about honesty.

The product form of the claim: *for a user with an 8GB box, no other system delivers more verified
correct answers per dollar per day.* That is a measurable sentence.

## 1.5 The size envelope (operator constraint, 2026-07-23 — supersedes any 7B-as-cheap-tier framing)

**The focus tier must run on CPUs, small GPUs, and less-optimized PCs. 7B-class models crash the
reference workstation — they are too large to BE the product tier.** Therefore:

- **Product/cheap tier: ≤3B-class, ≤4GB footprint, CPU-viable** (Qwen2.5-1.5B/3B-class today).
  The probe ladder makes this workable, not just tolerable: at **1.5B** the internal truth signal
  already clears the verifier gate (**0.980 factual / 0.774 assoc de-glossed AUROC**, measured) —
  the CPU-viable tier has a usable calibration signal. At 0.5B it does not (0.703 assoc).
- **7B+ is escalation-tier only** — cloud or capable boxes, never assumed on the user's machine.
  The measured 0.829 HumanEval (7B Q4) is re-scoped from "our baseline" to *escalation-tier
  reference*; the product baseline to measure is the 1.5B/3B tier's own number.
- **The ternary artifact (ADR-0026) is the capability path, not an optimization**: W1.58A8 puts a
  7B-class parameter count in ~2GB with CPU-native kernels (BitDistill: 2.65× faster CPU) — the
  only route to "7B-class capability on the computer you already own." Probe survival at ternary
  (#2873) is accordingly promoted from acceptance-test to critical-path.
- **Consequence for the math:** with a smaller p (1.5B-class solve rate), §2.1's verifier
  amplification is not an enhancement — it is *the* mechanism. The product is N cheap CPU samples
  + a real verifier, not one big model call.

## 2. The math (each formula: status, then the numbers we actually have)

### 2.1 Verifier amplification — why a small model can reach large-model pass@1 on verifiable work
For a task with executable tests, sample N candidates from the cheap model (per-candidate solve
probability p), keep the first that passes the visible tests:

    P(verified solve) = τ · (1 − (1−p)^N)  +  (1−τ) · FA(N)      cost ≈ N·c₀ + c_exec

where τ = probability the visible tests catch a wrong program (test adequacy), and FA(N) the
false-accept from weak tests. **Status: the (1−(1−p)^N) core is standard pass@k mathematics
(Chen et al. 2021) — imported, not ours; the system contribution is running it with a real
exec-verifier and a deterministic outer loop.**
**Validated in-repo:** 7B Q4_K_M measured **0.829** single-shot HumanEval-164 on-box
([quant-cliff run](../BENCHMARKS.md)); the exec-verified coding-golden gate measured **0.96**
pass@1 (#2173). Predicted by the formula: p=0.55 (0.5B tier), N=8, τ≈0.9 → ~0.89 verified at
~8×cheap-cost ≈ **still ≥5× cheaper than one 7B call** by the measured cost ratio.
**NOT yet validated:** the full HumanEval-164 *cascade* number (the missing run, now queued —
§4). τ on HumanEval visible tests is unmeasured in-repo; literature puts hidden-test
false-accepts at 5–15%, so FA is a real term, not a footnote.

### 2.2 Cascade economics — the cost side of the frontier
With cheap-tier sufficiency σ (verifier-confirmed solves) and escalation rate e = 1−σ to a tier
costing c₁:

    E[cost] = c₀ + e·c₁        E[accuracy] = σ + e·ρ      (ρ = escalation rescue rate)

**Status: elementary decision-theoretic cascade (FrugalGPT lineage — imported); our contribution
is instrumenting it with a ground-truth verifier so σ is *confirmed*, not self-assessed.**
**Validated in-repo (live, #2798/#2800 + ADR-0030 Phase-0):** strong cheap tier ran e≈0 at
**8.3× cheaper**; weak-tier + rescue measured **88.4% > 84.8%** (rescue is real); fully-local
0.5B→7B cascade solved **18/18 MBPP-basic at e=6%**; honest-unsolved reporting observed (the
`rle` task) rather than a fabricated pass.

### 2.3 Abstention as expected-utility optimum — why honesty is a *scoring* advantage, not a virtue
Under any deployment where a wrong assertion costs λ (review time, broken CI) and a correct one
pays +1:

    E[U] = P(assert ∧ correct) − λ·P(assert ∧ wrong)   ⇒   assert iff P(correct) > λ/(1+λ)

A calibrated confidence signal makes the threshold implementable; an uncalibrated one makes it
noise. **Status: proper-scoring folklore (Kalai lineage) — imported. Our addition is the
*signal*: the white-box probe.**
**Validated in-repo:** probe AUROC on de-glossed truth **0.837 → 0.980 → 1.000** (factual) and
**0.703 → 0.774 → 0.924** (associated-misconception hard case) across 0.5B/1.5B/7B(4-bit) —
measured on our hardware, replicating [2606.02628] and *bounding* [2510.09033]'s pessimism as
scale-dependent. M1's ledger invariant replayed clean (0 free rises / 48 pairs).
**NOT yet validated:** the probe threshold used *live* as the assert/abstain gate on a benchmark
(that composition is exactly issue #2858's experiment); probe survival at 1.58-bit (#2873).

### 2.4 SWE-bench honestly — where we actually are
**Measured truth: 0/5 agentic (autowork), 0/3 single-shot Qwen.** No math above turns a 0 into a
leaderboard number, and we will not pretend otherwise. What the math *does* predict: SWE tasks
decompose into steps with executable checks (repro script → failing test → patch → suite), which
is the cascade's native shape; and under §2.3 any system that submits fewer wrong patches at equal
solves dominates on reviewer-cost-weighted scoring. **The claim for SWE is therefore staged:**
first a *non-zero verified resolve% with measured abstention precision* (target: SWE-bench Lite
25-task slice), then frontier-of-cost comparisons — never raw-leaderboard talk before a number
exists.

## 3. Validated vs. predicted — the one table evaluators should hold us to

| Quantity | Formula/claim | Status | Number (source) |
|---|---|---|---|
| 7B Q4 HumanEval-164 single-shot | baseline | **MEASURED** | 0.829 (on-box quant run) |
| exec-gated coding-golden pass@1 | verifier works | **MEASURED** | 0.96 (#2173) |
| cheap-tier sufficiency (easy set) | σ | **MEASURED** | 18/18 @ e=6% (Phase-0 live) |
| cascade cost advantage | c₀+e·c₁ | **MEASURED** | 8.3× cheaper, e≈0 (#2800) |
| rescue value | ρ>0 | **MEASURED** | 88.4% > 84.8% (offline) |
| probe truth-decoding (7B, 4-bit) | calibrated signal exists | **MEASURED** | 1.000 factual / 0.924 assoc |
| M1 no-free-confidence on ledger | invariant holds | **MEASURED** | 0 free rises / 48 pairs |
| VTD self-improvement | crossover to net lift | **MEASURED-NEGATIVE so far** | −6 → ±0 (dose-response) |
| HumanEval-164 full-cascade verified pass@1 | §2.1 composition | **PREDICTED ~0.88–0.92** | not yet run (queued) |
| SWE-bench Lite resolve% | staged claim | **MEASURED 0** — honest floor | harness ready, run queued |
| live probe-gated abstention on a benchmark | §2.3 threshold | **NOT VALIDATED** | #2858 experiment |

## 4. The falsification plan (what turns claims into numbers)
All heavy runs on the **mookman lane / cloud L4** (this workstation is disqualified for training —
operator decision 2026-07-23, #2850):
1. **HumanEval-164 cascade run at the SIZE ENVELOPE** — cheap tier = 1.5B/3B-class (CPU-viable),
   escalation = cloud-only; report ⟨verified pass@1, cost/task, e, precision-of-claimed-solve,
   CPU tokens/s⟩ vs (a) the tier's own single-shot baseline (to be measured first), (b) the 7B
   escalation reference 0.829, (c) published numbers. Register in BENCHMARKS.md. *The §2.1
   prediction (N-sample exec-filtered ≥0.85 at the small tier) is falsifiable by this run.*
2. **SWE-bench Lite 25-slice** — resolve% + abstention precision, both reported; success = any
   verified non-zero with precision ≥0.9, else the honest null stands.
3. **Probe-gated live abstention** (#2858) — does gating by the probe raise utility at λ∈{1,3}?
4. **V1 honest-teacher verdict** (#2850, handed off) and V2 dose-response (#2847).

## 5. Stated plainly for human evaluators
We have **not** demonstrated SOTA on HumanEval or SWE-bench, and at raw leaderboard terms with a
small model we never will — that is a constraint of physics and parameter count, stated up front.
What exists today: **a measured 0.829 HumanEval baseline on an 8GB box; a live verified cascade
measured 8.3× cheaper with real rescue value; a truth-decoding internal signal measured at
0.92–1.00 AUROC at the 7B tier; and composition math — none of it novel, all of it standard
pass@k/cascade/proper-scoring theory — predicting ~0.9 verified HumanEval at a fraction of
single-model cost.** The prediction is falsifiable by one queued run. Honesty enters not as the
product's slogan but as the *scoring theorem* (§2.3): under any accounting where wrong answers
cost something, calibrated abstention strictly dominates — and we measured the calibration signal.
Judge us on the table in §3 and on whether the queued runs land where the math says.
