# Pre-registration: the Kalshi weather maker candidate, gated by the backtest-validity literature

**Date:** 2026-07-25 · **Type:** Pre-registration. Written and committed **before** the
out-of-sample cities are scored. **Read-only analysis; no orders.**
**Discovery set (IN-SAMPLE, frozen):** KXHIGHNY, 59 settled markets / 10 days — maker +1.37c per
contract net of full fee, day-clustered t = 2.02.
**Out-of-sample set (untouched at time of writing):** KXHIGHCHI, KXHIGHLAX, KXHIGHMIA, KXHIGHDEN,
KXHIGHAUS, KXHIGHPHIL.

## What kind of work this is

This is **pre-registration under multiple testing** — applied statistics with a mature literature,
not novel research. The posture is the repo's standard ADOPT rule: take the established protocol,
do not invent thresholds. The previous draft of these gates invented every number in it
(t >= 2.5, 65% of markets, +0.5c). Those are replaced below by protocol elements with citations.

## The two results that reshape the gates

**Pav, *Post-Selection Estimation of Sharpe Ratios*
([arXiv:2606.01650](https://arxiv.org/abs/2606.01650))** — the problem of estimating the true
performance of a candidate *selected for having the best observed in-sample performance among
many*. This is exactly what happened: weather was chosen because it was best of three series.
The naive in-sample estimate is therefore **biased upward**, and the correction is a shrinkage
estimator (the paper finds James-Stein best across realistic parameters, then GMLEB). This is a
correction to the **estimate**, which no previous gate of mine applied — only to thresholds.

**AlgoXpert IS-WFA-OOS protocol
([arXiv:2603.09219](https://arxiv.org/abs/2603.09219))** — the staging discipline: in-sample
evaluated on *stable regions* rather than point optima; walk-forward with **purge gaps** against
leakage; out-of-sample under **strict parameter lock with no further tuning**; **majority-pass**
plus **catastrophic-veto** decision rules; and overfitting detected via **performance decay
across chronological stages**.

## Correction to the in-sample number, recorded

The in-sample t was first reported at **1.99 treating 59 markets as independent**. They are not:
59 markets span **10 days**, and same-day markets are a *strike ladder* on one temperature
outcome (if the high is 84F, every strike above settles NO and every strike below settles YES) —
near-perfectly correlated. The correct independent unit is the **day**.

Recomputed on days: mean **+1.15c**, sd 1.79, n = 10, **t = 2.02**, 6/10 days profitable. The
clustering did *not* destroy the result — aggregating to days averages out within-day noise,
offsetting the lost degrees of freedom. A crude sqrt(cluster-size) adjustment predicted t = 0.82
and was **wrong**; it is recorded here because the wrong correction was stated aloud before it
was computed.

With 9 degrees of freedom, **t = 2.02 is p ~ 0.07 — not significant at 0.05**, before any
post-selection correction. The in-sample result is a *candidate*, nothing more.

## The gates (fixed before scoring the OOS cities)

All computed at the **city-day** level — the independent unit — never at market level.

| gate | rule | provenance |
|---|---|---|
| **W1 — clustered significance** | pooled OOS mean > 0 with **p < 0.05**, t-test on city-day units | standard inference; the unit fixed by the clustering correction above |
| **W2 — post-selection shrinkage** | decision uses the **James-Stein shrunk** estimate of the OOS mean, not the raw max; raw reported alongside | Pav 2606.01650 |
| **W3 — strict parameter lock** | OOS scored with the **identical code path, fee model and estimator** as the IS run. No tuning, no new filters, no re-bucketing | AlgoXpert OOS stage |
| **W4 — majority pass + catastrophic veto** | **>= 4 of 6 cities** individually positive net-of-fee AND **no city worse than -2.0c** per contract (a catastrophic-loss veto overrides a majority) | AlgoXpert decision rules |
| **W5 — decay check** | OOS pooled mean **>= 50% of the IS mean** (i.e. >= +0.57c). Sharp decay across chronological/structural stages is the overfitting signature | AlgoXpert performance-decay detector |
| **W6 — fill realism** | edge survives assuming the strategy captures only **25%** of observed maker volume, with the fee unchanged | deployment realism; a newcomer competes for queue position |

**KILL:** W1 or W4 fails -> the candidate is dead and the weather maker edge is recorded as
refuted, not "needs more data."
**PARTIAL:** W1 and W4 pass but W5 fails -> real but decaying; paper-trade only, no sizing.

## Explicitly out of scope for this test

- **The fee assumption is not resolved by these gates.** The maker is charged the full taker-fee
  formula throughout, which is conservative. If Kalshi waives or reduces maker fees the true edge
  is larger; that must be confirmed against the live fee schedule before any sizing decision, and
  it is *not* something this backtest can establish.
- **No live deployment follows from passing.** The maximum this test can license is a
  paper-traded, fee-verified maker experiment.
