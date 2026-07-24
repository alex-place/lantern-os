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
