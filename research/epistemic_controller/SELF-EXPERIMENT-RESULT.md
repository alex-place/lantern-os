# The self experiment — result, and where Robin sits

**Date:** 2026-08-19. Everything below is a measured number from a script in this directory.
Where a claim was made earlier and is now wrong, it is marked SUPERSEDED, not deleted.

---

## 1. The question

Robin (FutureHouse, arXiv:2505.13400, `github.com/Future-House/robin`) already runs the loop we
were describing as our target: literature → assay proposal → hypothesis generation → LLM-judged
pairwise ranking → selected assay → candidate generation → experiment → data analysis → next
round of candidates. It found ripasudil for dry AMD that way. So "LLM proposes a hypothesis,
reality answers, LLM proposes a better one" is not a gap we can claim.

The gap is one step further in. Robin's unit of work is **a research workflow**: *what experiment
should we run?* The unit we are after is **a self-experiment**: *what experiment should I run to
find out how I need to change?* Robin can discover "compound X is promising". It has no way to
discover "my ranking function systematically prefers a cheap misleading proxy".

Two details from Robin's own paper matter for how we build:

- They report that Robin "almost always called tools in the same order, leading to a
  deterministic workflow", and so they rewrote it as a fixed notebook. The agentic layer was
  decoration; the value was the pipeline. That is direct external support for the order we are
  building in: deterministic controller first, LLM only where it measurably beats it.
- Their loop has no null control. Nothing in the paper asks what Robin proposes when there is no
  mechanism to find. Our benchmark's D4 and world S's C1/C2 exist for exactly that, and C2 is
  what killed the result below — which is the point of having it.

## 2. What we built and what it says

`self_model.py` + `run_world_s.py`. Six episodes of world H per seed (truth `z` vs a **cheaper**
proxy that agrees with it 85% of the time; slots re-randomised every episode, so nothing about
*names* can carry over — the only thing learnable across episodes is something about the machine
itself). The selection policy `utility = explained / cost^e` is biased toward the proxy. The
self-model watches its own misses, and if they are cost-patterned it proposes `e: 1 → 0.5 → 0`,
runs two episodes as a **trial**, and keeps the repair only if the miss rate actually fell.

Pre-registered gates, thresholds frozen before the first run and not moved:

| gate | bar | result | |
|---|---|---|---|
| S1 baseline does not learn on its own | ±10 pts | 20.3% → 21.0% | PASS |
| S2 self-diagnosis reduces proxy purchases | ≤ half | 20.3% → 20.3% | **FAIL** |
| S3 does not fire in the two controls | < 10% each | 0% and 0% | PASS |
| S4 it pays (experiments per discovery) | ≥ 10% cheaper | 0.8% | **FAIL** |

**VERDICT: KILLED.** The mistake ledger does not let the scientist repair its own policy.

The kill is sharper than a null result, because we ran the obvious rescue. The strict evidence
rule ("the miss was cheaper than what finally worked") is unanswerable in ~60% of failures — when
the episode runs out of budget there *is* no survivor — so it almost never fires. Loosening it to
"cheaper than the median candidate" doubles the firing rate (13 → 29 seeds of 100)… and fires on
**both controls** (12% on C1, 20% on C2), which is S3 failing. Specific but silent, or loud but
wrong. Both variants ship in `self_model.py` behind `cost_reference=` so the trade is auditable.

The honest reading: **a cross-episode ledger of misses, keyed on the cost of what was bought,
does not carry enough signal to separate "my policy is biased" from "this world is hard."** If
self-diagnosis is to work, the diagnostic feature has to come from somewhere other than the
outcome ledger — most likely from a *counterfactual*: what would the other ranking have chosen,
and would it have survived? That is measurable here (probe data is already collected) and is the
next thing to test.

## 2b. Round two: the counterfactual, and what it is worth (2026-08-19, later)

The kill above named the next thing to try: stop asking the outcome ledger and ask a
**counterfactual** instead. At every DESIGN round the controller already recorded, per probed
candidate, how much of the residual it explained and what it cost, and by the end of the episode
it knows which observable survived — self-observable, no ground truth. So replay the round under
a different cost exponent and ask whether *that* policy would have picked the survivor. Paired,
and counting only **discordant** rounds: where both policies pick the same candidate the round
says nothing. That is the property the ledger lacked — a hard world produces failures but not
disagreement; a biased policy produces disagreement that resolves one way.

**First, is the repair worth making?** Without that number a null result is unreadable.
`run_cost_exponent_sweep.py`, 200 seeds of world H:

| cost exponent | truth committed | proxy bought | experiments/seed |
|---|---|---|---|
| 1.0 (shipped) | 89% | **20%** | 6.54 |
| 0.5 | 90% | 11% | 6.47 |
| 0.0 | 92% | **5%** | 6.29 |

A 74% cut in wasted purchases, a better truth rate, and slightly fewer experiments. So the ceiling
is real and any failure to reach it is a failure of **diagnosis**, not of the repair.

**Then, does the machine find it?** The 6-episode pre-registered run said no for every mechanism.
That turned out to be evidence-budget-bound rather than mechanism-bound: a single scientist rarely
sees enough discordant rounds in six episodes. Run again at 20 episodes (60 seeds, **same gates,
same thresholds** — a longer world is a different experiment, not a moved bar):

| arm | proxy bought, early → late | reduction | share of the oracle's available gain | fires in C1 / C2 |
|---|---|---|---|---|
| `hold` (no self-model) | 21.8% → 19.0% | 13% | 17% | — |
| `self` (mistake ledger) | 20.7% → 16.8% | 19% | 25% | 0% / 0% |
| `self-loose` (loose ledger) | — | — | — | **20% / 33%** |
| **`self-cf` (counterfactual)** | 20.2% → **12.2%** | **40%** | **53%** | **0% / 0%** |

Gates, unchanged: **S2 FAILS** (40% reduction against a ≥50% bar). **S3 PASSES** — 0% false firing
in both controls, after 509 and 704 explicit null diagnoses, meaning it looked and said no.
**S4 FAILS** (3.7% fewer experiments per discovery against a ≥10% bar).

So the counterfactual is the first mechanism that is *both* specific and effective, and it still
does not clear its bars. It captures a little over half of the gain that simply hard-coding the
better policy would have given, and it pays for that with 18 reverted trials out of 46 — the trial
machinery catching diagnoses that fired too early. The bars do not move; the honest verdict is
**not proven, and now quantified**: 53% of the available gain, at 20 episodes, with specificity
intact.

What that changes: "can a machine diagnose a defect in its own experiment policy" is no longer a
yes/no with a null answer. It is a rate, with a measured ceiling, a measured floor (13% drift), and
one mechanism sitting between them. The next question is whether the gap to the ceiling is evidence
budget (more episodes) or estimator quality (the discordant-pair test is crude) — separable by
running the same arm at 60 episodes and seeing whether it converges to the oracle or plateaus.

## 2c. Round three: it is the evidence budget, and S2 has a defect

Round two left one question: is the gap to the oracle an evidence-budget limit or an estimator
limit? Run the same arm at 60 episodes and see whether it converges or plateaus.

| | 20 episodes (60 seeds) | 60 episodes (30 seeds) |
|---|---|---|
| discordant rounds available to the diagnosis | 182 | 275 |
| proxy bought, `hold` late | 19.0% | 18.7% |
| proxy bought, `self-cf` late | **12.2%** | **9.6%** |
| below the `hold` arm's own late rate | 36% | **49%** |
| share of the gain above the oracle floor (5%) | 49% | **67%** |
| experiments per discovery vs `hold` | 3.7% cheaper | 5.1% cheaper |
| fires in C1 / C2 | 0% / 0% | 0% / 0% |

**It converges.** Every cross-arm measure improves with more episodes and none has flattened, so
the limit is how much disagreement a single scientist has seen, not the crudeness of the
discordant-pair test. Specificity is unchanged at both lengths — 0% false firing in both controls,
after 1,567 explicit null diagnoses in C2 at 60 episodes.

**And S2 has a defect I have to name.** S2 compares an arm's late window to its own early window,
with the split at `EPISODES // 2`. At 60 episodes "early" is episodes 1–30, which already contains
most of the learning, so the arm's own baseline is contaminated by the effect being measured: the
within-arm number *falls* from 40% to 31% while every cross-arm measure *rises*. A gate that gets
weaker the longer you run it is a bad gate.

The bar does not move and the verdict does not change: **S2 as pre-registered FAILS at both
lengths, S3 passes at both, S4 fails at both.** But the within-arm reading is not the sound one,
and the honest summary of the mechanism is the cross-arm row: at 60 episodes the counterfactual
self-diagnosis puts the machine 49% below the never-learning baseline and two-thirds of the way to
what hard-coding the right policy would have given — with no false firing in either control.

## 3. What the failed experiment actually bought

Building world S found four defects in the shipped controller — none of them visible in the
worlds it had already passed:

1. **Probe accounting made experiment order free.** The benchmark charged 4 probes per DESIGN
   regardless of how many were bought, so a better probe order could not show up as a saving.
   The instrument could not measure the thing it was built to measure. Now: probes are bought
   sequentially in `_probe_order()` and the round stops as soon as one clears the bar the
   controller already uses (`retract_below`). No new constant.
2. **A failed expansion left the model unfitted.** After dropping a candidate, the explorer was
   rebuilt but never refit, so it predicted 0 — and the next DESIGN scored candidates against raw
   `y`, which `x` alone explains. Every candidate cleared the bar and the **cheapest** won. This
   is the bug that made the cost bias look like a policy problem.
3. **Rejected candidates were re-bought in the same episode** — one trace bought the same proxy
   twice and ran out of budget doing it. Now rejection excludes, and (4) below makes it revocable.
4. **Probing was not budgeted.** The budget gated acquisition only, so a controller that kept
   retracting could buy probe rounds forever: one traced episode spent 11× its budget across 206
   experiments. Now DESIGN checks the budget before probing.

Plus one design correction that came out of (3): **a rejection is a hypothesis too.** If nothing
left explains the residual, the earlier rejection is re-admitted before the boundary is retracted
— a candidate can fail transiently when its window still straddles the old regime.

Effects, all on frozen gates:

| | before | after |
|---|---|---|
| world H, commit variant, truth over proxy | 66% (INCONCLUSIVE) | **92%** (PASS) |
| world H, hold variant | 86% | **98%** |
| H4 control (hidden-variable world) | 87% / 86% | 93% / 92% |
| benchmark, one-shot discoveries per experiment | 0.107 | **0.146** |
| benchmark, false discoveries (one-shot) | 4 | **0** |

**SUPERSEDED:** world H's earlier headline — *"the shipped controller is incomplete; holding the
expansion as a hypothesis is what separates two explanations"* — was mostly defect (2). With the
defect fixed, one-shot commit already gets 92%. Holding still helps (98% vs 92%) but it is a
refinement, not the mechanism. `results/world_h.json` and SCRIPTS.md carry the correction.

## 4. Relation memory: real, and under its bar

`memory.py` — validated relations kept as **re-testable hypotheses that re-rank the probe queue**,
never as carried model state (the naive version, carrying the expanded class forward, was killed
earlier: −47% and 80 false discoveries).

| regime | one-shot | relation memory | |
|---|---|---|---|
| rule repeats (seeds 0–59) | 0.1445 | 0.1742 | +20.6% |
| rule repeats (holdout 200–399) | 0.1490 | 0.1764 | **+18.4%** |
| rule does not repeat (holdout) | 0.1510 | 0.1496 | 0.99× — no harm |
| false discoveries | 0 | **0** | |

Pre-registered bar was **+25%**. It is not met, on either seed set. The bar does not move. The
effect is real and consistent in direction — fewer experiments (3140 vs 3699) for slightly more
discoveries — but it is a ~20% effect that was pre-registered as a ≥25% one, so the gate reads
FAIL and the claim stays unproven.

## 5. What this makes the project

Not "an AI that does science" — Robin does that. The thing we have that Robin does not is the
**layer underneath**: a deterministic, auditable diagnosis of *why* a prediction failed, with a
null control attached to every claim it makes. It currently separates three causes (parameters,
missing observation, wrong model class) with measured gates. It does **not** yet separate the
fourth (a defect in its own experiment policy) — world S is the record of that attempt failing,
with the mechanism of the failure identified.

The next experiment is the counterfactual test named in §2, and the one after it is running this
diagnosis layer above a Robin-shaped scientist rather than above least squares.
