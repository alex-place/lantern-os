# Epistemic controller — a deliberately tiny research instrument

**Read [EPISTEMIC_BOUNDARY_MVP.md](EPISTEMIC_BOUNDARY_MVP.md) first.** It is the claim, the four
things (State, Evidence, Transition, Pass/Fail), and the reason there is no LLM in the loop.

This directory is disposable and is not wired into the product.

## Result (2026-07-27)

The claim — *when prediction errors become persistent and structurally unexplained by the
current model class, the controller must seek discriminating evidence before permitting a
model/weight update* — **survives** on the hidden-variable world, across 200 development seeds
and **300 held-out seeds with thresholds frozen**:

| gate | holdout (n=300) | bar |
|---|---|---|
| P1 enters BOUNDARY after the switch, never before | **100%** (0 early) | ≥ 80% |
| P2 refuses parameter updates while in BOUNDARY | every time | always |
| P3 chooses the true hidden variable from 4 candidates | **88%** (chance 25%) | ≥ 80% |
| P4 final MSE within 2× irreducible noise | **88%** — twin 0.62 vs A-alone 5.47 | ≥ 80% |
| P5 null world (drift, no hidden variable) false alarm **held** | **0.0%** (raised 78%, retracted 78%) | < 5% |

No LLM anywhere: A is least squares, B is three residual-structure tests, the selector is
explained-variance-per-cost. **The mechanism lives in the controller.**

## What broke on the way, in order — this is the useful part

1. **Baseline bug (controller).** An EMA baseline seeded at t=8 froze at ~35× the true nominal
   MSE; the 3× threshold sat at 8 and a real 30× jump never tripped it. 58% of worlds never left
   NOMINAL. Found by P1. Fix: median MSE over the settled warm-up window.
2. **"Structured" ≠ "class is wrong" (design).** With the baseline fixed, the null world
   (slow parameter drift) hit BOUNDARY 38%. The auditor was *right* — a model fit on all history
   lags a drifting truth, so its residual has a slope — but the failure is parametric (forget old
   data), not model-class (add a variable). Fix: SUSPECT exhausts the parameter hypothesis with
   a recency refit before any class call. 38% → 15%.
3. **Retraction (design).** The BOUNDARY call is a hypothesis; DESIGN is its test. If no
   available observable explains the residual, the honest conclusion is "I was wrong about the
   class" — not "buy the best decoy." Measured: real boundaries, best candidate explains ≥ 0.96;
   drift false alarms, ≤ 0.92. Disjoint. Retract below 0.94. 15% → 0% held. The machine had told
   us this itself — in a false-alarm BOUNDARY it bought the same decoy twice.
4. **Auditor rule (design).** 2-of-3 tests could never catch the target: a hidden i.i.d.
   z∈{−1,+1} gives two residual bands with *zero* autocorrelation and a normal runs statistic —
   only bimodality fires. The three tests see different structures; requiring agreement threw
   the signal away. Any-of-3, with retraction carrying the false-alarm load. Detection 84→100%.
5. **Budget (constant).** 20% of correctly-diagnosed seeds could not afford the measurement.
   Arbitrary constant, raised to cover one probe round plus one measurement.

Items 2–4 are the actual content: **the difference between "I need more data" and "I need a
different representation" is not a threshold; it is (a) exhaust the parametric explanation
first, and (b) treat the class-failure call as a hypothesis that the evidence search can
retract.** A null world that raises 78% and retracts 78% is the controller *working*, not a
suppressed alarm.

Two thresholds (retract 0.94, budget 10) were set after seeing seeds 0–199 — the kind of
threshold-moving refused elsewhere in this repo. Each is defended as a measurement (an observed
gap; an arbitrary constant that starved correct diagnoses), and the real defence is the 300-seed
holdout they were not tuned on and pass.

## Is any of it new? — the prior-art search

Bounded search (web + corpus, 2026-07-27), recorded in
[docs/research/2026-07-27-retraction-by-remedy-failure-prior-art.md](../../docs/research/2026-07-27-retraction-by-remedy-failure-prior-art.md).
The system is assembled from known parts and the broad claim has a direct ancestor — Adam the
robot scientist (King et al., *Science* 2009) already runs hypothesis → experiment → falsify →
revise. Structural-vs-parametric mismatch is a named problem in MPC diagnosis (Srinivasan &
Bonvin 2018). What survives is narrow: **retraction by remedy-failure** — a deliberately
sensitive detector whose false alarms are caught *downstream* by the emptiness of the design
space, not upstream by threshold calibration. Every false-alarm mechanism found in the literature
runs the other way. Graded **AUDITED-CANDIDATE ✓**, not breakthrough; world H is the kill test.

## Honest limits

One world class (missing binary variable), linear A, one slow variable. The ten hostile worlds
in the MVP doc (wrong causal direction, confounding, sensor bias, two fitting explanations,
measurement-changes-system, …) are experiment 3 and are not run. No LLM in either role yet —
that is experiment 2, and it is measured *against* this baseline: if an LLM-B cannot beat three
residual tests at P3/P5, it is not an upgrade.

## Run

```bash
python research/epistemic_controller/run_mvp.py 200
```
