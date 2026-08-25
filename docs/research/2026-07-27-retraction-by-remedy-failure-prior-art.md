# Prior-art search: is anything in the epistemic boundary MVP new?

**Date:** 2026-07-27 · **Type:** bounded novelty audit (web + local corpus, one session, ~10
queries) against the repo's own ladder: `NOT-NOVEL` → `CANDIDATE ★` → `AUDITED-CANDIDATE ✓`.
"Proven novel" is never self-declared.

**Short answer:** the MVP as a *system* is assembled from known parts. The broad claim I floated
("a model-class-failure call is a hypothesis to be falsified") has a direct ancestor. One narrow
thing survives, and it is graded AUDITED-CANDIDATE, not breakthrough.

## What is NOT novel — with the ancestor named

| what the MVP does | ancestor | status |
|---|---|---|
| Residual-structure tests (autocorr, runs, bimodality) | Durbin–Watson 1950; Wald–Wolfowitz 1940; Sarle 1983 | NOT-NOVEL |
| Autocorrelation of prediction error → model mismatch → retune | **US 9,904,257 (Fisher-Rosemount, 2018)** — detects mismatch by autocorrelation and *directly* triggers a retuning cycle, no confirmation | NOT-NOVEL; and this is the paradigm the MVP contrasts with |
| Structural vs parametric mismatch as distinct failure kinds | **Srinivasan & Bonvin, *J. Process Control* 72 (2018)** — classifies MPM into "structural (unmodeled dynamics)" vs "parametric"; notes "the difficulty of further determining whether the mismatch is structural or parametric" | NOT-NOVEL — the *distinction* is named; the *difficulty* is stated |
| Choosing a measurement by explained variance / cost | BOED (Lindley 1956); active learning; model-discrimination designs | NOT-NOVEL |
| "The failure call is a hypothesis; design an experiment; falsify; revise" | **Adam, the robot scientist** — King et al., *Science* 324 (2009): "originates hypotheses… devises experiments to test them… interprets results to falsify hypotheses inconsistent with the data, and repeats the cycle" | NOT-NOVEL — this kills the broad form of the claim outright |
| Diagnostic that triggers a prespecified fallback when misspecification is detected | Armstrong, *Adapting to Misspecification*, Econometrica 2025 | adjacent — fallback is fixed, not searched |
| False-alarm control in online change detection | Martin, Satterthwaite & Barnett, arXiv:2607.15423 (July 2026) — **upstream**: simulation-calibrated thresholds controlling a sequential FWER. Also confirmation windows, persistence requirements | NOT-NOVEL, and the opposite direction from the MVP |

## What survives, stated as narrowly as the evidence allows

> **Retraction by remedy-failure.** A model-class-failure diagnosis is kept deliberately
> *sensitive* (hair-trigger detector), and the false alarm is caught **downstream** by the
> failure of the remedy: if no available observable explains the structured residual, the
> structural diagnosis is retracted *because the search for the missing structure came up
> empty* — and the parametric repair is applied instead.

Why the ancestors do not cover it:

- Every false-alarm mechanism found is **upstream** — calibrate the threshold, require
  persistence, add a confirmation window. They ask the detector to be *more sure before acting*.
  This does the opposite: it lets the detector be unsure and makes the **emptiness of the design
  space** the falsifier.
- Adam falsifies **hypotheses about the world** by running experiments on the world. This
  retracts a **hypothesis about the model's own adequacy**, and the falsifier is not an
  experiment outcome but the *absence of any candidate that could explain the discrepancy*.
  "Nothing I can measure explains this" is evidence about the diagnosis, not about the
  phenomenon.
- Srinivasan & Bonvin name structural-vs-parametric as hard to decide. The answer here is: *don't
  decide it at the detector — let the remedy's failure decide it.*

**Measured profile that no upstream-calibrated system produces:** on the null (drift-only)
world the detector raises BOUNDARY 78% and the controller retracts 78%, holding 0% —
*with* a detector that fires on 15% of pure noise. Sensitivity and false-alarm rate are
decoupled at the detector and re-coupled at the remedy. 300 held-out seeds.

It is also the same object as two other findings on this branch, which is why it gets this much
attention: the §9 composition failure (two certificates passed and nothing downstream could
revoke the composition) and the twin machine's one rule (B's halt is a prediction reality grades,
not a verdict). One sentence covers all three: **a claim of failure is itself a claim, and it
must be revocable by the machinery that acts on it.**

## Grade and what would kill it

**AUDITED-CANDIDATE ✓** — on the narrow form only. Bounded search found the ancestors of the
broad claim and no instance of downstream retraction-by-remedy-failure with a deliberately
sensitive detector, in change-point detection, MPC mismatch diagnosis, BOED, or automated
discovery. That is the strongest status this repo self-assigns.

**Kill condition (experiment 3, world H):** two explanations fit the current data equally. If a
decoy observable can explain the residual at ≥ 0.94 for the wrong reason, the retraction signal
is blind, and the decoupling collapses back into needing an upstream threshold — at which point
this is just a confirmation window with extra steps. Until world H is run, "AUDITED-CANDIDATE"
is the ceiling.

## Sources

- King et al., "The Automation of Science," *Science* 324:85 (2009) — https://www.science.org/doi/abs/10.1126/science.1165620
- Srinivasan & Bonvin, "Detection of model-plant mismatch and model update for reaction systems using concept of extents," *J. Process Control* 72:17–29 (2018) — https://www.sciencedirect.com/science/article/abs/pii/S0959152418302245
- US 9,904,257 B2, "Using autocorrelation to detect model mismatch in a process controller," Fisher-Rosemount Systems (2018) — https://patents.google.com/patent/US9904257B2/en
- Martin, Satterthwaite & Barnett, "Sequential Control of False Positives in Online Change Point Detection," arXiv:2607.15423 (2026) — https://arxiv.org/abs/2607.15423
- Armstrong, "Adapting to Misspecification," *Econometrica* (2025) — https://onlinelibrary.wiley.com/doi/full/10.3982/ECTA21991
- Cruz-Martinez, Cuesta-Lazaro, Held & Kagan, "Model Misspecification in ML for Physics," arXiv:2608.13633 (2026) — iterative detect/mitigate loop, human-in-loop, no retraction mechanism
- Barlas, Sloman & Kaski, "Robust Experimental Design via Generalised Bayesian Inference," arXiv:2511.07671 (2025) — misspecification in BOED (pulled earlier)
