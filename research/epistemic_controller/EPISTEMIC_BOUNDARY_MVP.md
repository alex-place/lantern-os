# Epistemic Boundary MVP

**One sentence, and everything here exists to try to kill it:**

> When prediction errors become persistent and structurally unexplained by the current model
> class, the controller must seek discriminating evidence before permitting a model or weight
> update.

This is a deliberately tiny research instrument, not the machine. It is disposable. It is not
wired into the product. It has no weight updates, no web, no physical experiments. It has four
things — **State, Evidence, Transition, Pass/Fail** — and nothing else.

## Why it is built with no LLM in the loop first

The claim is about a *controller*, not about a model. A frontier model asked "is this residual
structured?" will say yes whenever it is, and that proves nothing about the mechanism. So the MVP
runs with deterministic parts throughout:

| role | MVP implementation | what it must NOT be |
|---|---|---|
| A (explorer) | ordinary least squares on the current feature set | anything that can "notice" a missing variable |
| B (auditor) | a residual-structure test: autocorrelation + runs test + bimodality | a model that is told what to look for |
| controller | a state machine with explicit, logged transition rules | either agent |
| environment | synthetic, deterministic given a seed, cheap, infinitely repeatable | anything with infrastructure |

If the mechanism works with no model in it, an LLM in A or B is an *upgrade* measured against this
baseline. If it needs an LLM to work, it was "LLM picks experiment" all along — which already
exists, and is not the thing being tested.

## State

```
NOMINAL        the current model explains the data; ordinary parameter updates are permitted
SUSPECT        error has risen; the controller is collecting evidence about WHAT KIND of failure
BOUNDARY       residuals are persistent AND structured; the model CLASS is judged inadequate;
               parameter updates are REFUSED
DESIGN         choose the measurement that best discriminates candidate explanations
ACQUIRE        take that measurement (it costs; the budget is finite and logged)
EXPAND         construct a larger model class that includes the new observable
RESOLVED       the expanded model explains the data; back to NOMINAL on the new class
```

## Evidence (append-only; every transition cites the evidence ids it rests on)

- `residual`   — a window of `e_t = y_t − ŷ_t`
- `structure`  — the auditor's verdict on that window: `{lag1_autocorr, runs_z, bimodality, p_noise}`
- `failure_class` — `PARAMETER | DATA | MODEL_CLASS`, with the evidence it was decided on
- `design`     — the candidate measurements, their scored utility, and which was chosen and why
- `measurement` — the acquired values of the chosen observable
- `expansion`  — the new model class and its fit

## Transition rules (explicit; logged with the evidence that fired them)

```
NOMINAL  → SUSPECT    when windowed MSE exceeds k × its NOMINAL baseline for ≥ W steps
SUSPECT  → NOMINAL    when a PARAMETER refit brings MSE back under the baseline
                      (the failure was parametric: the class was fine)
SUSPECT  → BOUNDARY   when, AFTER a parameter refit, residuals remain structured:
                      p_noise < α on ≥ 2 of 3 structure tests, over ≥ W steps
                      → failure_class = MODEL_CLASS; parameter updates now REFUSED
BOUNDARY → DESIGN     always (the only legal exit from BOUNDARY — never RETRAIN)
DESIGN   → ACQUIRE    the measurement with max utility = Δexplained / cost is chosen;
                      the decision and the runner-up scores are logged
ACQUIRE  → EXPAND     the observable is added to the feature set
EXPAND   → RESOLVED   if the expanded model's residuals pass the structure tests
EXPAND   → DESIGN     otherwise (the chosen observable did not explain it; choose again)
```

**The transition the whole MVP exists to measure is `SUSPECT → BOUNDARY → DESIGN`, and
specifically that BOUNDARY never exits to a parameter update.**

## Pass / Fail (pre-registered; thresholds fixed before the first run)

Against a world `y = a·x + b + c·z` where `z` is hidden at first and four candidate observables
`z₁…z₄` are offered, of which exactly one is `z`:

| | baseline: A alone (refit forever) | twin controller |
|---|---|---|
| P1 | never enters BOUNDARY (it has no such state) | enters BOUNDARY after the switch, not before |
| P2 | keeps updating parameters | refuses parameter updates while in BOUNDARY |
| P3 | — | chooses the true `z` from the four candidates in ≥ 80% of seeds |
| P4 | final MSE stays at the structured-residual floor | final MSE within 2× the irreducible noise |
| P5 | — | a **null world** (no switch; pure parameter drift) NEVER enters BOUNDARY (false-alarm rate < 5%) |

**KILL:** P3 fails (it picks a decoy as often as the truth) → the selector is not diagnosing
inadequacy, it is guessing; OR P5 fails → the controller calls BOUNDARY on ordinary drift, and
"refuse parameter updates" becomes the harm term — the machine is a professional skeptic.

P5 is the one that matters most. A controller that refuses updates whenever error rises is
trivially "careful" and useless. The claim is only interesting if BOUNDARY is *specific* to
model-class failure.

## Evaluation of B

B is never rewarded for stopping A. B is scored on one thing only: **did B's declared
MODEL_CLASS failure correspond to a real one?** Precision and recall of the BOUNDARY call
against the world's ground truth (did a hidden variable switch on, or not). A B that halts
everything scores recall 1, precision ~0.5 and fails P5. That is how a professional skeptic
is caught.

## Not in this MVP, on purpose

No LLM in the loop (that is experiment 2, measured against this baseline). No weight updates
(experiment 4 at the earliest). No web, no physical world, no integration into the product. The
ten hostile worlds (missing variable, wrong causal direction, distribution shift, confounding,
misleading correlation, sensor bias, non-stationarity, two fitting explanations, proxy mismatch,
measurement-changes-system) are experiment 3: the benchmark is whether the controller separates
*"I need more data"* from *"I need a different representation"* across them.
