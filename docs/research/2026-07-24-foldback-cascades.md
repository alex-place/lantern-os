# Foldback cascades — nature's error-repair control flow beats monotone escalation, and only under frustration

**Date:** 2026-07-24 · **Type:** Research note — a control-flow claim ported from protein
folding, with a closed-form mechanism and a pre-registered simulation.
**Status:** [derived — theorem below] + [measured — simulation, gates PASSED after one
honest gate failure and the control that resolved it].
**Loop stage:** Reason (the verified cascade's escalation topology) — no new subsystem.
**Artifact:** [`folding_cascade_frustration.py`](../../experiments/folding_cascade_frustration.py)
→ [`results JSON`](../../experiments/results/folding_cascade_frustration.json)
**Applies to:** `spiral-harness` / ADR-0030 verified cascade (today: monotone escalation).

---

## TL;DR

> Every verified cascade we ship — and every one in the public literature — escalates
> **monotonically**: try cheap, and on failure re-solve the *whole* task at a stronger tier.
> **Protein folding, optimized over ~4 billion years of selection, never does this.** It
> assembles small cooperative units (**foldons**), each verified unit stabilizing the next
> (**sequential stabilization**), and repairs errors by **partially unfolding back to the
> last stable foldon** — Englander's "predetermined pathways with optional errors." Ported
> to reasoning cascades, this predicts a specific and *conditional* win, which is what makes
> it falsifiable: the advantage should be **exactly zero when no error can hide from local
> verification**, and grow without bound as hidden errors ("frustration") become common.
> **Closed form:** a retry that re-solves *m* steps survives the hidden-error draw with
> probability (1−q)^m, so full restart pays (1−q)^K while partial unfolding pays (1−q)^m —
> an advantage factor of **(1−q)^−(K−m)**, exponential in the *preserved prefix* and
> identically 1 at q = 0. **Measured** (pre-registered gates, equal compute, retry-matched
> baseline): **+0.83pp at zero frustration** (the predicted null) rising monotonically to
> **+39.7pp**, at **half the compute**. The first run *failed* its own anti-confound gate at
> +2.05pp; the retry-matched control isolated the mechanism and is now the primary
> comparator — recorded because hiding it would make the result a lie.

---

## 1. What nature actually does (corpus, named)

Three findings from the folding literature carry the load here. None of them is ours; all
are load-bearing and none has been applied to verified reasoning cascades.

**(a) The landscape is a funnel, and evolution built it that way.** Energy-landscape theory
(Bryngelson & Wolynes; [Onuchic, Luthey-Schulten & Wolynes, *Annu. Rev. Phys. Chem.* 1997](https://www.annualreviews.org/doi/abs/10.1146/annurev.physchem.48.1.545))
resolves Levinthal's paradox: proteins do not search conformation space, they descend a
funneled landscape biased toward the native state. The **principle of minimal frustration**
says foldable sequences are those whose local interactions mostly agree with the global
native state — and this is *selected*, with direct evidence that folding landscapes evolved
toward minimal frustration ([PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1613892114)).
The design lesson is inverted from ML's usual one: **you do not make the searcher smarter,
you make the landscape funneled.**

**(b) Folding is hierarchical and sequential, in verified units.** Englander & Mayne's
foldon framework: structure assembles as ~20-residue **cooperative units**, and *previously
formed foldons guide and stabilize the next* — "de novo prediction of protein folding
pathways using the principle of sequential stabilization"
([PNAS 2012](https://www.pnas.org/content/109/43/17442); [the case for defined pathways,
PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1706196114)). Cytochrome c folds as five
foldons that continually unfold and refold even under native conditions.

**(c) Errors are repaired by partial unfolding, not restart.** The unified mechanism is
"**predetermined pathways with optional errors**" ([PMC2203325](https://ncbi.nlm.nih.gov/pmc/articles/PMC2203325)):
misfolds occur, and are resolved by locally reversing to a prior stable state and
re-folding — never by denaturing the whole chain, never by pushing forward. Frustration is
also not purely pathological — *localized* frustration is functional, at binding and
allosteric sites ([Ferreiro & Wolynes, *Acc. Chem. Res.* 2021](https://pubs.acs.org/doi/10.1021/acs.accounts.0c00813)).

**Genome-scale, the same theme with an extra lesson.** Chromatin folds hierarchically by
**loop extrusion**: SMC complexes (cohesin/condensin) extrude loops until stopped by bound
**CTCF boundary elements**, forming TADs ([Nat. Rev. Mol. Cell Biol. 2021](https://www.nature.com/articles/s41580-021-00349-7);
[Science Advances](https://www.science.org/doi/10.1126/sciadv.aaw1668)). The lesson for us
is the *boundary*: nature does not place unfold-boundaries arbitrarily — they are **marked**,
and the marks are under selection. Where a cascade places its foldon boundaries is therefore
a first-class design variable, not an implementation detail (open question, §6).

## 2. The port

| folding | verified reasoning cascade |
|---|---|
| residue / local move | one reasoning or tool step |
| **foldon** (~20-residue cooperative unit) | a locally-verifiable segment of the solution |
| **sequential stabilization** | verified prefix constrains the search for what follows |
| native-state check | global verifier (execution, tests) |
| **frustration** (local interaction conflicts with native state) | **a step that passes local verification but blocks the global solution** |
| misfold repair by **partial unfolding** | escalate/re-solve *only the unfolded suffix*, keep the verified prefix |
| denature-and-restart (does not happen) | monotone escalation / global restart (what we all ship) |
| chaperone (GroEL) isolation | escalate a stuck segment to a different tier/context (future rung, §6) |

The frustration row is the one that matters: it is the *dominant* failure mode of multi-step
agentic reasoning — every step looks fine, the whole thing is wrong — and it is exactly the
class of error that local verification is blind to by construction.

## 3. The theorem (why partial unfolding wins, and when it cannot)

Let a task have K steps. On a retry at tier with per-step correctness p, a re-solved step
introduces a **hidden** (locally invisible) error with probability `q = (1−p)·φ`, where φ is
the frustration rate. Hidden errors are independent across re-solved steps, so a retry that
re-solves *m* steps survives with probability `(1−q)^m`.

- **Monotone escalation / global restart** re-solves the whole task: `m = K`.
- **Foldback** re-solves only the unfolded suffix: `m = jF` for j unfolded foldons of size F.

> **Advantage factor = (1−q)^−(K−m)** — exponential in the *length of the preserved prefix*,
> and **identically 1 when q = 0**.

Two consequences, both falsifiable. **(i) The null:** with no frustration (φ = 0, or perfect
local verification) foldback has *no* advantage — any observed win at φ = 0 is a
retry-budget artifact, not the mechanism. **(ii) The scaling:** the advantage grows
exponentially in K. This is Levinthal's paradox in its error-correction form — at K in the
hundreds (a real protein; a long agent trajectory) global restart is not merely wasteful,
it is *unreliable*, because every restart re-rolls every step's chance of hiding a new error.

## 4. Pre-registered test, and the gate that failed first

Gates fixed **before** the first run: **G-F1** — at φ = 0 the advantage must be ≤ 2pp at
equal compute (else it is a retry artifact and the mechanism story is false); **G-F2** — the
advantage must grow with φ and exceed +10pp somewhere; **KILL** — no advantage > 2pp
anywhere means the analogy is poetry, record and stop.

**First run: G-F1 FAILED at +2.05pp** against the plain monotone baseline. Diagnosis: the
foldback policy also received *more retry opportunities* than its comparator, so the two
explanations were confounded. Rather than move the threshold, we added the discriminating
control — **retry-matched monotone** (cheap pass, then repeated *full* strong passes until
budget is exhausted: same escalation, same retries, **no prefix preservation**) — and stated
the prediction before rerunning: it should close the φ = 0 gap while leaving the
high-frustration advantage intact. It did.

Results (K = 8, foldon = 2, p_cheap = 0.72, p_strong = 0.93, cost 1:4, **equal budget 64**,
3 seeds × 4,000 tasks):

| φ (frustration) | retry-matched monotone | **foldback** | Δ vs retry-matched | Δ vs plain monotone |
|---|---|---|---|---|
| 0.0 | 0.992 | 1.000 | **+0.83pp** (the predicted null) | +2.05 |
| 0.1 | 0.960 | 1.000 | +3.97 | +4.88 |
| 0.2 | 0.918 | 0.999 | +8.18 | +8.87 |
| 0.3 | 0.878 | 0.999 | +12.09 | +12.69 |
| 0.5 | 0.794 | 0.998 | +20.39 | +20.68 |
| 0.7 | 0.708 | 0.995 | +28.68 | +28.84 |
| 1.0 | 0.592 | 0.989 | **+39.69** | +39.69 |

**Gates: G-F1 PASS (+0.83pp ≤ 2), G-F2 PASS (+39.7pp, monotone in φ). VERDICT: SUPPORTED.**
Foldback also spent **~half** the compute (14–18 vs 24–37 units) — it wins the success axis
while *not* using its budget. Global same-tier restart degrades *below* monotone at high φ
(0.463 at φ = 1.0), which the theorem predicts: repeated full restarts maximize hidden-error
exposure.

## 5. What this says to build

The prescription is small and concrete, and it contradicts what every cascade currently
does: **on global-verify failure, do not re-solve the task — unfold the last verified
segment and re-solve only that, escalating the segment rather than the task.** Keep the
verified prefix as a constraint. Unfold further back only when the near unfold fails.

In this repo that is a change to the verified cascade's escalation policy
(`spiral-harness`, ADR-0030), which today escalates monotonically. It is gated on the one
thing we cannot yet measure (§6) — the *real* frustration rate — because the theorem says
the entire value of the change is proportional to it.

## 6. Honest scope, open questions, kill criteria

- **This is a simulation with a stipulated error model.** The independence of hidden errors
  across re-solved steps is the assumption doing the work; correlated frustration (a wrong
  early commitment that *makes* later steps wrong) would change the constants and could
  favour deeper unfolding. Not tested here.
- **The real frustration rate φ is unmeasured.** Our cascade telemetry
  (`data/eval/cascade/*.jsonl`, 16 rows) is flat two-tier with no per-step verification, so
  φ cannot be estimated today. **Instrumentation ask:** log per-step local-verify outcomes
  alongside the global verdict; φ̂ = P(step passed local | task failed global). Until then
  the win is conditional and must be stated that way.
- **Boundary placement is unsolved and nature says it matters** (CTCF marks TAD boundaries;
  foldons are not arbitrary cuts). We used fixed 2-step foldons. Learned or marked
  boundaries are the obvious next rung.
- **Chaperone rung untested:** when repeated unfolding fails, biology moves the substrate to
  an isolated environment (GroEL) rather than retrying in place — the analogue is re-solving
  a stuck segment in a *different* context/tier. Stated, not tested.
- **Kill criteria (pre-stated for the next rung):** the claim dies if, on real multi-step
  traces, (a) φ̂ ≈ 0 (local verification is not blind in practice, so there is nothing to
  win), or (b) foldback fails to beat retry-matched escalation at measured φ̂ on a real
  benchmark at equal spend. Either outcome is publishable as a negative and will be recorded
  as such.

## 7. Novelty position

[Landscape of Thoughts](https://arxiv.org/abs/2503.22165) (ICLR 2026) visualizes LLM
reasoning trajectories descriptively (t-SNE over distance-to-answer features) — no
funneledness or frustration theory, no control-flow prescription. Backtracking search
(DFS/tree-of-thought, backjumping in CSP/SAT) is the closest algorithmic relative and is
correctly named as prior art: **what is new here is not "backtrack" but (i) the frustration
model that says *when* backtracking is worth anything and when it is provably worthless,
(ii) the closed-form exponential-in-preserved-prefix advantage, and (iii) the pre-registered
null at φ = 0** — which is what separates a mechanism from a folk heuristic. The biology is
imported and cited, not claimed.

*Provenance: this note came from an operator's metaphor — that the spiral "folds like a
protein," curling back to older rungs when a hard cascade solves an easy problem. Taken at
face value and grounded, it produced a falsifiable control-flow claim with a closed form and
a measured null. Recorded because the origin is part of the evidence trail.*

---

## 8. Rung B — the unfold-depth law: repair granularity is the inverse error rate

Rung A left the foldon size stipulated (fixed 2-step units). But the theorem's own logic
forbids a free choice: unfolding **too shallow** misses the error; unfolding **too deep**
re-exposes steps to fresh hidden errors. There must be an interior optimum. Derived before
running ([`folding_unfold_depth_law.py`](../../experiments/folding_unfold_depth_law.py)):
a repair unfolding the last *m* of K steps succeeds iff the latent error lies inside the
suffix **and** no new hidden error appears while re-solving it, so with uniform error
position

```
P(fix | m) = (m/K)·(1−q)^m       d/dm ⇒ 1 + m·ln(1−q) = 0
```

> ### **m\* = −1/ln(1−q) ≈ 1/q — and it does not depend on K.**
> Unfold exactly as far as you can expect to re-solve before introducing one new hidden
> error. **Repair granularity is set by the error rate of the machinery doing the repair,
> not by the length of the thing being repaired.**

**Measured (exact enumeration over 35 (K, φ) cells, plus an independent Monte-Carlo path):**

| K | φ | q | m\* predicted | m measured | advantage vs full restart |
|---|---|---|---|---|---|
| 128 | 0.2 | 0.014 | 70.93 | **71** | 1.24× |
| 128 | 0.3 | 0.021 | 47.12 | **47** | 2.05× |
| 128 | 0.5 | 0.035 | 28.07 | **28** | 7.71× |
| 128 | 0.7 | 0.049 | 19.90 | **20** | 35.5× |
| 128 | 1.0 | 0.070 | 13.78 | **14** | **428×** |

- **G-D1 (pre-registered): PASS** — worst |log₂(m_measured/m\*)| = **0.023** (1.6% error).
- **G-D3 (pre-registered): PASS** — slope of m_measured vs K is **exactly 0.0** at every φ
  where the optimum is interior. Depth is K-independent, as derived.
- **G-D2: FAILED AS WRITTEN.** It demanded an interior optimum across mid-range φ, but 16
  of those 25 cells have m\* ≥ K, where the theory *itself* predicts the boundary (unfold
  everything). Splitting cells by what the theory predicts: **13/13 predicted-interior
  cells are interior, and 22/22 predicted-boundary cells have their optimum exactly at K —
  35/35 overall.** Recorded as a mis-specified gate rather than a refutation, and flagged
  as a *post-hoc* split: only G-D1 and G-D3, which are unaffected, carry evidentiary
  weight here.
- Monte Carlo (independent implementation) reproduces the closed-form P(fix) at the argmax
  and its neighbours (e.g. K=128, φ=0.5: closed 0.0807 vs MC 0.0816).

**The two laws together are the engineering result.** Optimal repair depth is **constant**
in task length, while the penalty for using the wrong depth grows **exponentially** in it:
at φ=0.5 the advantage of correct-depth unfolding over full restart runs 1.0× → 1.58× →
**7.71×** as K goes 8 → 64 → 128, and reaches **428×** at φ=1. For short tasks this is a
rounding error; for long agent trajectories it is the difference between a cascade that
works and one that does not. **This is Levinthal's paradox for agents:** the failure of
long-horizon reasoning may be less about per-step capability than about repairing at the
wrong granularity.

**Biological consistency (heuristic, not a fit).** Observed foldons are ~15–25 residues
(Englander; cytochrome c folds as five units). If the law holds in the biological setting,
that implies a per-residue unrecoverable-misfold rate of **~4–7%** — the same range our
simulation's high-frustration rungs occupy (q = 0.049–0.070 → m\* = 14–20). An
order-of-magnitude retrodiction of a constant we did not fit, offered as a consistency
check only; establishing it properly is a biology question we are not equipped to settle.

**What it changes in practice.** The prescription is now quantitative, not directional:
estimate q from telemetry, set checkpoint/foldon granularity to ≈1/q, and unfold to that
depth on failure — deeper only when the near unfold fails. It also sharpens the
instrumentation ask: φ̂ was already the blocking measurement for *whether* to foldback; it
is now also the input that *sets the parameter*.

**Kill criteria for rung B (pre-stated for the next rung):** the law dies if measured
optimal depth on real traces is not within 2× of 1/q̂, or if it scales with task length
(which would falsify K-independence directly). Correlated frustration — an early wrong
commitment that *causes* later steps to be wrong — violates the independence assumption
and is the most likely way the constant-depth result breaks; untested, and named here as
the primary threat to validity.

---

## 9. Rung C — the structured counterexample: causal frustration breaks the depth law

Rung B named correlated frustration as the primary threat to validity. This rung attacks it
and **finds the counterexample** ([`folding_correlated_frustration.py`](../../experiments/folding_correlated_frustration.py)).

**Causal frustration:** a wrong step *poisons everything downstream* — later steps are built
on a false premise, so re-solving them cannot help. Repair works only if it reaches back
past the **root**, and the root is the *first* wrong step, hence geometrically distributed
and concentrated **early**. Derived before running:

```
P(fix | m) = (1-W)^(K-m) · (1-W')^m       d log P/dm = log(1-W') - log(1-W) = CONSTANT
```

> The objective is **log-linear in m: no interior optimum exists.** The optimum jumps to a
> **boundary** — and when the repair tier is better than the original pass, that boundary is
> **m = K, full restart**. Under causal frustration the depth law is not inaccurate, it is
> **inapplicable**, and the policy rung A beat becomes optimal again.

**Measured — the optimum migrates from the law to the boundary** (law prescribes m = 19):

| correlation c | K=16 | K=32 | K=64 | K=128 | slope m* vs K |
|---|---|---|---|---|---|
| 0.00 | 16 | **19** | **19** | **19** | +0.018 (law holds) |
| 0.25 | 16 | 32 | 20 | 20 | −0.022 |
| 0.50 | 16 | 32 | 20 | 20 | −0.022 |
| 0.75 | 16 | 32 | 64 | 20 | +0.002 |
| **1.00** | **16** | **32** | **64** | **128** | **+1.000** |

At c = 1 the optimum is m\* = K for *every* K: **K-independence is falsified as sharply as
it can be** (slope exactly 1.0 against a 0.25 threshold).

**The prescription doesn't just degrade — it inverts, then collapses.** Policy contest at
equal budget:

| c | K | fixed-depth 1/q (rung B) | full restart | progressive | **root-seeking** |
|---|---|---|---|---|---|
| 0.0 | 128 | **1.000** | 0.004 | 0.510 | 0.256 |
| 0.5 | 32 | 0.546 | 0.480 | 0.234 | **0.955** |
| 1.0 | 32 | 0.171 | 0.479 | 0.079 | **0.952** |
| **1.0** | **128** | **0.000** | 0.004 | 0.000 | **0.254** |

- **G-C2 PASS** — at c = 1 the rung-B policy scores **below** plain full restart (−30.8pp at
  K=32). The advice inverts against the baseline it originally beat.
- **The purest counterexample is the last row:** at c = 1, K = 128, fixed-depth unfolding
  succeeds **0.000** of the time. Not a degradation — *total failure*, because the root is
  early and the prescribed 19-step suffix essentially never reaches it. And "unfold deeper"
  is no rescue: full restart scores 0.004. **Both known policies collapse together.**
- **G-C1: PASS on the conjunct that matters, FAIL as written.** The gate ANDed two tests:
  slope > 0.25 (passed decisively at **1.0**) and depth > 2× the law (fails at K = 16, 32,
  where the law's own prescription of 19 is ≥ K). Same boundary-cell bug as G-D2 —
  **that is twice now, and the pattern is worth naming: a gate that compares against a
  prescription must first check the prescription is feasible.** Reported, not rewritten.

**The constructive answer, and it is a different algorithm.** Root-seeking — binary-search
the first bad prefix with a *prefix oracle*, then unfold from the root — is
**correlation-invariant**: 0.952–0.955 at K=32 and 0.252–0.265 at K=128, *across every value
of c*. It does not care how errors propagate because it localizes the cause exactly (**G-C3
PASS**, +47.3pp at c=1, K=32). But it is **not a universal winner**: at c = 0, K = 128 it
scores 0.256 against fixed-depth's 1.000, because it pays oracle cost and re-solves from an
early root where a shallow unfold would have sufficed.

### The regime map (the actual deliverable)

| frustration structure | optimal policy | why |
|---|---|---|
| **independent** (c ≈ 0) | fixed-depth unfold at **m = 1/q** | interior optimum exists; rungs A–B |
| **causal** (c → 1), prefix oracle available | **root-seeking** (bisect) | localizes the cause; correlation-invariant |
| **causal**, no prefix oracle | full restart | no interior optimum; must reach an early root |

The phase boundary itself moves with K: at c = 0.75, K=64 has already flipped to the
boundary while K=128 has not, because full restart degrades exponentially in K and so stays
unattractive longer. **c, not just φ, is a quantity worth measuring** — it selects the
*algorithm*, where φ only sets the *parameter*.

### What biology says about this, and where we can beat it

Nature evolved **two** mechanisms, and this result explains why it had to. Native-state
hydrogen exchange shows foldon-level *local* unfolding and refolding under native
conditions — the independent-error regime. Kinetically trapped (correlated) states get a
*different machine*: the **GroEL/GroES chaperonin** encapsulates the substrate and gives it
a fresh folding attempt in isolation — global restart in a protected box. Two regimes, two
machines, which is exactly what the regime map predicts.

The third row is ours. **Root-seeking beats both, and biology cannot use it** — bisecting
for a root cause requires interrogating *prefixes*, and a polypeptide has no way to ask
"would a valid completion follow from this partial structure?" A reasoning cascade can:
that is what a verifier over partial solutions *is*. So the honest summary is that we take
the control flow from ~4 billion years of selection, and then beat it on the one axis where
our instruments are better than nature's.

**Status of the program after rung C:** the depth law is *scoped*, not refuted — it holds
under independent frustration (where it is exact to 1.6%) and fails completely under causal
frustration (where it is worse than doing nothing clever). Any deployment must therefore
measure **both** φ̂ and ĉ before choosing a policy, which strengthens rather than weakens the
instrumentation ask: per-step local-verify outcomes give φ̂; whether failures cluster in
*suffixes after a first bad step* gives ĉ.

---

## 10. Pre-registered interpretation (written BEFORE the real-trace numbers, §11)

The measurement in `measure_frustration_on_real_traces.py` adjudicates whether the rung A–C
program applies to a real cascade at all. To stop the result being fit to a story after the
fact, the decision rule is fixed here first. φ̂ ∈ [0,1] = fraction of tests still passing in
globally-failing solutions; ĉ ∈ [0,1] = causal-correlation (mixture estimator, ICC-checked).

| observation | verdict for the program |
|---|---|
| **φ̂ < 0.1** | Local checks catch almost everything → **nothing to win from foldback.** Rungs A/B are theoretically correct but practically inert on this workload. Honest downgrade to "interesting under conditions this cascade does not exhibit." |
| **φ̂ ≥ 0.1 and ĉ < 0.3** | The regime rung B targets. Fixed-depth unfold at m≈1/q is the predicted win; **worth building** (behind the instrumentation). Strongest outcome for the depth law. |
| **φ̂ ≥ 0.1 and 0.3 ≤ ĉ ≤ 0.7** | Mixed regime. The phase boundary is live; policy must be chosen per-task from (φ̂,ĉ). Regime map is the deliverable, not a single policy. |
| **φ̂ ≥ 0.1 and ĉ > 0.7** | Causal regime. **The depth law is inapplicable here** (rung C) and root-seeking / restart is required — the counterexample, not the law, describes reality. Still a real finding: it says the useful artifact is the prefix-oracle root-seeker. |

Two honesty caveats fixed in advance:
- **This is a coding cascade with unit tests** — an unusually *favourable* case for measuring
  φ (tests are real partial-credit local checks). A workload without decomposable verification
  could have very different φ̂; the number generalizes to "verified cascades with per-unit
  checks," not to all reasoning.
- **The weak-coder failures are a proxy** for the cheap-tier failures the real cascade repairs.
  If the measured φ̂/ĉ from a 0.5B coder differ materially from the 7B tier's, that is itself a
  finding (frustration is tier-dependent) and the honest move is to re-measure at the escalate
  tier before any build. Stated now so it cannot be waved away later.

Whatever the numbers, they are reported in §11 as measured — including the outcome that
**kills the practical case** (φ̂ < 0.1), which is the one that would most tempt a rewrite.

---

## 11. The adjudicating measurement — result (read against §10, which was fixed FIRST)

φ̂ and ĉ measured on 120 real MBPP/TACO problems the cascade actually ran, generating the
failing attempts with a 0.5B coder and executing every assertion in isolation
([`measure_frustration_on_real_traces.py`](../../experiments/measure_frustration_on_real_traces.py)
→ [`frustration_real_traces.json`](../../experiments/results/frustration_real_traces.json);
65 failing solutions, 195 tests):

| quantity | value |
|---|---|
| global solve rate (0.5B) | 0.458 |
| **φ̂** (tests still passing in a globally-failing solution) | **0.092** |
| **ĉ** (mixture / ICC cross-check) | **0.143 / 0.153** |
| all-or-nothing failures | 78% |

**Read against the pre-registered bands: φ̂ = 0.092 lands in the first band (φ̂ < 0.1) — the
one §10 flagged as "kills the practical case" and "the outcome that would most tempt a
rewrite."** I honor it. On this workload the local checks (individual test assertions) catch
almost every error — a failing solution fails ~91% of its tests — so there is very little
*hidden* frustration for foldback to exploit. **The repair-policy prescription (rungs A–C) is
practically inert on this workload**, exactly as pre-registered for this band. ĉ = 0.14 is
firmly independent (it would put us in the "fixed-depth, worth building" regime *if* φ̂ cleared
0.1), but φ̂ is the binding constraint and it does not clear.

Two things this does **not** mean, held to the caveats also fixed in §10 before the number:
1. **Not a refutation of the theory.** The error-threshold law and regime map (§12) are about
   *when* repair helps; the measurement says this workload sits in the low-φ corner where the
   theory *predicts* little foldback value — a confirmation of the theory's own boundary, not
   a contradiction of it.
2. **Workload- and tier-specific.** Coding with unit tests is an unusually *strong* local
   verifier (caveat 1), and the 0.5B failures are a proxy for the cheap-tier failures the real
   cascade repairs (caveat 2). The pre-registered next step stands: re-measure at the escalate
   tier and on a workload with *weak* per-step verification (multi-step tool use, planning,
   proof) — the regimes the theory says carry high φ — before any build.

**Net: the "build foldback into the cascade now" case is NOT supported on this workload.**
Recorded as measured. This is the honest downgrade §10 pre-committed to, and it is the correct
outcome of the discipline — the number fell below the line, so the practical claim does not
ship.

## 12. Is it SOTA, not just novel? The fractured envelope + the error threshold

Novel (nobody did exactly this) and SOTA (beats the best existing method) are different bars.
Answered in [`folding_sota_and_error_threshold.py`](../../experiments/folding_sota_and_error_threshold.py).

**Prior art at the source.** The closest published method is **REPOT** ("Recoverable
Program-of-Thought via Checkpoint Repair", [arXiv:2605.30052](https://arxiv.org/abs/2605.30052),
June 2026): it backs up to the failure point and repairs — but, confirmed by reading it, has
**no closed-form backup depth, no independent-vs-correlated error distinction, and no strategy
selection.** So REPOT is *one cell* of the regime map (root-localized repair) applied
unconditionally. Reflexion / Self-Refine = full restart; Tree-of-Thoughts / LATS = shallow
stepwise backtrack; Self-Backtracking = explicit backtrack actions. Each is a *fixed* policy.

**Finding 1 — the SOTA envelope is regime-fractured.** Steelmanned implementations (REPOT given
a perfect failure locator), equal compute, over (K, c) at φ = 1:

| K | c | Reflexion (restart) | ToT (stepwise) | REPOT (checkpoint) | fixed-depth 1/q | **selector** |
|---|---|---|---|---|---|---|
| 32 | 0.0 | 0.477 | **1.000** | 0.947 | 0.908 | 1.000 |
| 32 | 0.5 | 0.476 | 0.517 | **0.950** | 0.512 | 0.950 |
| 32 | 1.0 | 0.480 | 0.049 | **0.950** | 0.122 | 0.950 |
| 128 | 0.0 | 0.004 | **1.000** | 0.234 | 1.000 | 1.000 |
| 128 | 0.5 | 0.004 | **0.500** | 0.240 | 0.499 | 0.500 |
| 128 | 1.0 | 0.003 | 0.000 | **0.239** | 0.000 | 0.239 |

**No single method dominates.** ToT is optimal for independent errors (1.000) and *fails
completely* under causal poisoning (0.000); REPOT is best under causal errors on short chains
(0.950) and degrades on long chains (0.234) as its suffix re-solve grows; Reflexion collapses
at long K (0.004). Whichever fixed method a practitioner commits to, there is a regime where it
fails badly — **G-S2 passes with 76–99pp margins.** A selector routing on (φ, c, K) — the
biology-derived candidate set (foldons→fixed-depth, GroEL→restart-in-isolation,
root-cause→checkpoint) — matches the envelope everywhere (**G-S1, within 2pp**).

*Honest scope on the selector:* recovering the envelope is expected once per-regime routing is
allowed — the content is the **map** (which method when, from measurable properties) and the
**fracture** (no universal method), not the selector "winning." The mixed-regime K-crossover
(64) is *calibrated* on this grid, not derived; its existence and direction come from rung C
(the phase boundary moves with K), its value does not. And the whole comparison is *simulated*
— a real-benchmark head-to-head against published REPOT/ToT is the unbuilt rung.

**Finding 2 — the reasoning error threshold (the deeper-biology result).** From Eigen's
quasispecies theory (1971): information is maintained only below a critical error rate; above
it, "error catastrophe." Ported: a chain of K steps repaired against per-step hidden-error
rate q can be produced clean in one pass only up to a critical length K_c. Measured — the
clean-pass probability crosses 1/e at

> **K_c · q = 0.96, 0.80, 0.80** for q ∈ {0.02, 0.05, 0.1} → **K_c ≈ 1/q**,

the *same* 1/q as rung B's optimal backup depth and Eigen's n < 1/(μs). This unifies three
biological mechanisms into one design law:

- **Kinetic proofreading** (Hopfield 1974 / Ninio 1975): insert verification checkpoints; each
  independent checkpoint *multiplies* discrimination, driving effective q down — which *raises*
  K_c. The cost is energy + speed (the [energy-speed-accuracy relation](https://arxiv.org/pdf/1710.06038)).
- **Error threshold** (Eigen 1971): a chain longer than ~1/q cannot be repaired at any single
  backup point — you *must* decompose into segments shorter than 1/q.
- **Foldback** (rungs A–C): within a below-threshold segment, back up (independent: depth 1/q;
  causal: root-seek).

Existing methods each implement one fragment (REPOT = root-seek repair; a process-reward model
= a single checkpoint; ToT = search) with no theory connecting them and **no length bound**.
The contribution is the bound (K_c ≈ 1/q — none of them have it), the map, and the prescription
(checkpoint every ~1/q steps to keep each segment below its error threshold).

**Honest SOTA verdict.** *Novel* is established: REPOT and the rest lack the depth law, the
error-structure distinction, and the threshold bound. *SOTA "by selection"* is shown **in
simulation** (the selector matches an envelope no fixed method dominates), not yet on a real
benchmark. And §11 found the one real workload measured sits *below* the frustration threshold
where any of this repair machinery pays off. So the defensible status is: **a new hard bound
(K_c ≈ 1/q) and a regime map that no prior method has — strong theory, SOTA-relevant — with the
empirical SOTA claim gated on (a) a real head-to-head benchmark and (b) a workload in the
high-φ regime.** That is the honest boundary, stated rather than papered over.
