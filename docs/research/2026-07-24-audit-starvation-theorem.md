# Audit Starvation: confidence-gated verification protects the beliefs that most need verifying

**Date:** 2026-07-24 · **Type:** Postable research note (self-contained; the public form of
slate claim M7). · **Status:** [derived — proofs below] + [measured — exact, machine-checked].
**Artifact:** [`audit_starvation_theorem.py`](../../experiments/audit_starvation_theorem.py)
(stdlib only, deterministic, no RNG — every number below reproduces to machine precision) →
[`results JSON`](../../experiments/results/audit_starvation_theorem.json)
**In-repo lineage:** [slate §M7](2026-07-21-owned-math-conjectures.md) ·
[proofs note Lemmas 3–4](2026-07-21-owned-math-proofs.md) ·
[#2924](https://github.com/alex-place/lantern-os/issues/2924)

---

## Abstract

A standard pattern in deployed LLM systems gates *verification effort* on *expressed
confidence*: retrieve when token probability is low (FLARE-style active RAG), audit when
uncertainty is high (uncertainty sampling), re-check when sampled answers disagree
(agreement/entropy gates). The design premise is that this concentrates verification where it
is needed. We give structured counterexamples showing the premise inverts on exactly the
failure that matters: a **self-reinforcing false belief** — one whose confidence grows by
self-consistency rather than evidence — **manufactures its own audit exemption**. For
threshold gates the confident region is *absorbing*: all catch opportunity is confined to a
finite vulnerability window (7 steps in the worked example), after which the belief is
immortal; if the belief is born above threshold (the documented overconfidence regime of
instruction-tuned models) the gate never fires at all, even with a perfect verifier. For
proportional gates the belief's gain schedule makes the audit series *summable* — the
incomplete-learning trap of bandit theory (Rothschild 1974), except that there the summable
exploration is a designer's mistake, while here **the adversarial belief imposes summability
on any gate that vanishes in confidence** (never audited with probability 0.284 in the worked
example, regardless of verifier power). A corollary is an inversion: the gate audits an
*honest, calibrated* belief unboundedly more than the confabulated one (8.6× by step 40,
→ ∞ asymptotically). We then prove a **starve-or-spend dichotomy**: any *provenance-blind*
gate — any function of confidence/agreement/activity observables — emits the same audit
schedule on the laundered belief and on a genuinely evidence-anchored twin with identical
observables, so it must either starve (finite total audits ⇒ positive escape probability) or
spend (infinite audits of settled truth). Per-belief **paid-evidence accounting** escapes the
dichotomy: constant hazard on unpaid beliefs (expected catch in 2 steps in the worked
example), zero redundant audits on paid ones. The empirical face of the starve branch has
already been measured in the wild as "retrieval-state lock-in" (42–59% of RAG errors silent
at N = 5 samples; arXiv:2606.22728); this note supplies the closed-form mechanism, the
impossibility, and the exit.

---

## 1. The gate pattern

Verification is expensive, so deployed systems ration it by expressed confidence:

- **Threshold gates.** FLARE (Jiang et al., 2023, arXiv:2305.06983) triggers retrieval iff
  any token of the tentatively generated sentence has probability below θ. Semantic-entropy
  and self-consistency monitors fire when sampled answers disagree.
- **Proportional gates.** Uncertainty sampling audits/labels an item with probability
  increasing in model uncertainty — the default active-learning allocation, and the shape of
  "retrieve more when uncertain" policies generally.

Both are instances of one schema: per-step audit probability `q_t = f(expressed confidence
trajectory)`, with `f` vanishing as confidence → 1. That vanishing *is* the efficiency
feature. It is also the vulnerability.

## 2. The counterexample dynamics

Let a belief hold odds `o_t` with confidence `c_t = o_t/(1+o_t)`. The adversarial (or merely
pathological) case is **self-reinforcement**: each step multiplies odds by a gain `g > 1` —
self-consistency, repetition, retrieval-state lock-in, majority agreement among samples that
share the same defective evidence state — with **zero external evidence ever paid to the
belief**:

```
o_t = o0 · g^t          c_t = o_t/(1+o_t) → 1          (worked example: g = 1.4, o0 = 1)
```

Two worlds matter throughout (the two-world construction; Lemma 3 of the companion proofs
note): **W_L (laundered)** — the odds path above, no evidence for the belief, ambient
evidence arriving for *other* beliefs; **W_G (anchored)** — the *same* odds path, but each ×g
is a Bayes update on genuine per-belief evidence with likelihood ratio g. Every
provenance-blind observable — the confidence trajectory, entropies, sample-agreement rates,
"did evidence arrive this step" activity bits — is **identical** in the two worlds at every
step. Only the *attribution* of evidence to the belief differs.

## 3. Results

All proofs are elementary; the point is what they compose into. Numbers are exact outputs of
the artifact.

**Theorem A (absorption — threshold gates).** For the gate "audit iff `c_t < θ`": since
`c_t` is increasing, the region `{c ≥ θ}` is absorbing. All catch opportunity is confined to
the finite window `t < t* = ⌈log_g(θ/((1−θ)o0))⌉`. With per-audit catch power ρ (an audit
fails to expose the false belief with probability 1−ρ — e.g., retrieval returns the same
defective neighborhood, the lock-in mechanism measured in arXiv:2606.22728):

> P(never caught) ≥ (1−ρ)^{t*},  and  = 1 whenever o0 ≥ θ/(1−θ) (born confident).

Worked example (θ = 0.9, g = 1.4, o0 = 1): **t\* = 7**. ρ = 0.5 → escape forever with
p = 0.0078; ρ = 0.2 → p = 0.21; **born-confident → p = 1 even at ρ = 1: the gate never
fires once.** Survive the window once and you are immortal — the catch probability stops
growing at step 7, permanently.

**Theorem B (endogenous summability — proportional gates).** For `q_t = α(1−c_t)`:
`Σ q_t = α Σ 1/(1+o0 g^t) ≤ α(1/(1+o0) + 1/(o0(g−1))) < ∞`. Hence (product criterion /
Borel–Cantelli): audits occur **finitely often a.s.**, expected lifetime audits
`Σ q_t` is a small constant, and

> P(never audited at all) = Π(1−q_t) > 0 — **independent of verifier power**.

Worked example (α = 0.5): E[lifetime audits] = **1.159** (closed-form bound 1.5);
**P(never audited) = 0.284.** A perfect verifier that is never called catches nothing.
General boundary: the trap engages iff `Σ(1−c_t) < ∞`, i.e. iff `Σ 1/o_t < ∞` — **any
superlinear odds growth suffices**; geometric gain is just the cleanest instance.

*Relation to prior art:* in bandit theory, a policy whose exploration probabilities are
summable has positive probability of settling on the wrong arm forever — Rothschild's (1974)
incomplete learning. There, summability is a **design mistake**. Here it is **manufactured by
the belief itself**: self-reinforcing confidence growth converts *any* audit rule that
vanishes in confidence into an incomplete-learning trap. The designer never chose a summable
schedule; the adversary chose it for them.

**Corollary (audit inversion).** An honest belief with calibrated, non-snowballing confidence
c̄ is audited at constant rate α(1−c̄) forever: expected audits grow linearly without bound,
while the confabulator's lifetime total is the constant above. Worked example (c̄ = 0.5,
T = 40): **10.0 expected audits for the honest belief vs 1.16 lifetime for the laundered
one — ratio 8.6× and → ∞.** Verification effort concentrates on honesty and vanishes on
confabulation — the exact opposite of the gate's design premise.

**Theorem C (starve-or-spend dichotomy).** Let π be *any* causal audit policy whose per-step
audit probability is a function of provenance-blind observables. On W_L and W_G those
observables coincide at every step, so π emits the **same schedule `(q_t)`** on both.
Exactly one of:

1. **Starve:** `Σ q_t < ∞` — then P(W_L never audited) = Π(1−q_t) > 0: the false belief
   escapes with positive probability, whatever the verifier's power;
2. **Spend:** `Σ q_t = ∞` — then π audits **W_G** — a belief that is, in that world,
   continuously evidence-paid and correct — infinitely often a.s.: unbounded verification
   spend on settled truth, which is precisely the cost confidence-gating exists to avoid.

**Corollary (attribution escapes).** The gate "audit iff no evidence was *paid to this
belief* this step" is not a function of the shared observables — it reads attribution. On
W_L it has constant hazard α (catch time ~ Geometric(αρ), expected 2 steps in the worked
example at ρ = 1); on W_G it audits **zero** times (the paid evidence stream *is* the
verification). It is strictly better on both axes of the dichotomy simultaneously.

Machine-checked table (T = 40, exact — no sampling):

| gate | P(catch W_L), ρ=1 | P(catch W_L), ρ=0.5 | audits spent on anchored twin | twin audits unbounded? |
|---|---|---|---|---|
| threshold (FLARE form) | 1.0* | 0.992* | 7.0 | no (absorbed) |
| proportional (uncertainty sampling) | 0.716 | 0.453 | 1.16 | yes (but summable) |
| uniform flat rate | 0.99999 | 0.995 | 10.0 | **yes — forever** |
| **attribution (paid-evidence)** | **1.0** | **0.99999** | **0.0** | **no** |

\* threshold catches only inside the 7-step window and only from a humble start; the
born-confident row of the artifact is P(catch) = 0 at any ρ.

## 4. Why this is not just miscalibration

The standard diagnosis — "confidence-gated retrieval fails because models are miscalibrated" —
undersells the problem in two ways.

First, **the failure is structural, not statistical.** Theorems A–B are not about the gate
misreading a noisy signal; they hold when the gate reads the confidence trajectory *exactly*.
The absorbing region and the summable schedule are properties of the *composition* (vanishing
audit rule ∘ self-reinforcing dynamics), so better calibration of the *same* signal does not
remove them — any belief that ever enters the runaway regime re-creates the trap.

Second, **no smarter function of the same signals can fix it** (Theorem C). The laundered
belief and its genuinely anchored twin present identical observables, so cleverness spent on
the gate function only moves you along the starve-or-spend frontier. The exit is a richer
*vocabulary* — attribution — not a better *policy* over the poor one. This mirrors, one level
up, the classical result that fault diagnosability in discrete-event systems is a property of
the observation map, not of the diagnoser (Sampath et al., 1995).

## 5. Related work, named

- **Retrieval-state lock-in** (arXiv:2606.22728, 2026): names and *measures* the phenomenon —
  42% of KG-RAG and 59% of dense-retrieval errors show zero answer dispersion at N = 5 ("the
  retrieval state is degenerate and near-identical across repeated samples, so resampling
  cannot surface the error"). Empirical only: no counterexample construction, no
  impossibility, fix is a conjunctive accept-gate plus human review. This note is the theory
  companion: the closed-form mechanism (Theorems A–B), the impossibility (Theorem C), and the
  attribution exit.
- **Incomplete learning in bandits** (Rothschild 1974; survey arXiv:1906.10173): positive
  probability of settling on the wrong arm under summable exploration. Ours: the summability
  is *endogenous* — imposed by the runaway belief on any confidence-vanishing gate.
- **FLARE / active retrieval** (arXiv:2305.06983): the deployed threshold gate; its authors
  scope it to calibrated bases. The overconfidence of instruction-tuned models is
  well-documented (e.g., the GPT-4 technical report's post-RLHF calibration regression;
  Kadavath et al. 2022 for the pre-RLHF baseline) — that regime is Theorem A's
  born-confident row.
- **Semantic entropy** (Farquhar et al., Nature 2024): detects *confabulations* (arbitrary,
  resample-variable errors) by design; consistent errors are explicitly out of scope — i.e.,
  agreement gates sit inside Theorem C's observable class.
- **Self-confirming equilibrium** (Fudenberg & Levine, Econometrica 1993; and the
  model-uncertainty extensions): the game-theoretic ancestor of the phenomenon — wrong
  beliefs persist because the actions they induce never generate disconfirming data, and
  escape requires off-path experimentation. An equilibrium concept, not a scheduling
  analysis: no audit-hazard closed forms, no absorption window, no summability mechanism,
  no observable-class impossibility, no attribution fix. Theorems A–C are, in that
  language, a hazard-rate account of *how fast* a verification gate manufactures its own
  self-confirming trap — and what vocabulary escapes it.
- **C-RAG** (arXiv:2402.03181): conformal certificates on generation risk *given* the
  retrieval pipeline — orthogonal object; it does not analyze the retrieve-decision
  feedback loop that Theorems A–B close.
- **Degenerate feedback loops in recommenders** (arXiv:1902.10730): formal divergence of a
  self-reinforcing loop under its own outputs — sibling dynamics, different object (interest
  drift), no audit-gating or attribution result.
- **Anchored confabulation** (arXiv:2604.25931): empirical non-monotone amplification of
  confident hallucination under partial evidence — a mechanism that *raises* o0, feeding
  Theorem A's born-confident regime.
- **Model collapse / self-consuming loops** (Shumailov et al.): the training-time sibling of
  the same provenance failure.

**What is claimed as new here:** the endogenous-summability theorem and its absorption twin;
the audit-inversion corollary; the starve-or-spend dichotomy over provenance-blind
observables with the attribution escape; and the exact, dependency-free artifact. (Priority
note: this extends the M7 attribution-loss result in this repository — Lemma 3, issue #2924,
PR #2925 — from activity-bit gates to confidence-trajectory gates.)

## 6. What builders should take from it

1. **Do not ration verification by expressed confidence alone.** Any such gate hands
   self-reinforcing errors a finite vulnerability window (threshold form) or a summable audit
   schedule (proportional form).
2. **Account evidence per belief.** Keep a paid/free split: which claims had external
   evidence actually land on them, when. Audit hazard should be a function of *unpaid
   confidence* — confidence not backed by attributed evidence — not of confidence. In this
   repository that split already exists in the convergence ledger (M1's paid/free mass), and
   the control-law guard consuming it is `evidenceForMode` (PR #2925).
3. **A hard re-grounding cadence is necessary but not sufficient** (slate M3 → M7): a timer
   guarantees audits *happen*; attribution decides they land on the belief that needs them.
4. **If you must keep a confidence gate,** pair it with a floor: `q_t ≥ q_min > 0` breaks
   summability (Σ q_t = ∞ ⇒ eventual catch a.s.) — at the price of the spend branch; the
   floor is exactly a hard cadence in disguise.

## 7. Honest scope & kill criteria

- The dynamics model is the geometric odds ratchet (this project's M6 lasing model). The trap
  needs only `Σ 1/o_t < ∞` (any superlinear odds growth); genuinely sublinear confidence
  growth defeats Theorem B (the series diverges) — and the artifact prints the boundary.
- Threshold gates from a humble start with a perfect per-audit verifier *do* catch the belief
  inside the window (first grid row: p_escape = 0). The counterexample bites under either
  documented premise: imperfect audits (lock-in) or born-confident beliefs (RLHF
  overconfidence). Proportional gates need no such premise.
- Theorem C's impossibility is relative to the observable class (provenance-blind functions).
  That is the content, not a loophole: the fix is a vocabulary change. If a deployed "gate"
  already secretly reads attribution (e.g., checks that the retrieved passage *entails the
  specific claim*), it is on the attribution side of the dichotomy and out of scope.
- Kill criteria: Theorem B's claim dies if someone exhibits a confidence-*only* gate
  (no floor, no attribution) with unbounded expected audits along some path with
  `Σ 1/o_t < ∞` — the algebra says none exists; the falsifier is a two-line check against
  the artifact. The *relevance* claim dies if self-reinforcing confidence growth is shown not
  to occur in deployed systems — against which: arXiv:2606.22728's 42–59% silent-error rates
  and the lock-in mechanism.

---

*Repository context: this is the public form of slate claim M7 (attribution loss). The
internal companion measured the same mechanism inside our shipped convergence control law and
grounding allocator, and shipped the attribution guard. Everything here is reproducible from
`experiments/audit_starvation_theorem.py` in one command with no dependencies.*
