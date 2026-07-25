# REFUTED: the Kalshi weather maker edge, and the liquidity-provision mechanism behind it

**Date:** 2026-07-25 · **Type:** Refutation. Both tests pre-registered before scoring.
**Read-only analysis; no orders placed at any point.**
**Pre-registration:** [`2026-07-25-kalshi-weather-maker-prereg.md`](2026-07-25-kalshi-weather-maker-prereg.md)
(committed `78efbf58`, before the out-of-sample data was scored).
**Artifacts:** [`kalshi_weather_maker_oos.py`](../../experiments/kalshi_weather_maker_oos.py) ·
[`kalshi_maker_edge_vs_liquidity.py`](../../experiments/kalshi_maker_edge_vs_liquidity.py)

## The claim that died

A maker (liquidity-provision) edge in Kalshi weather markets: **+1.37c/contract net of full fee**
on KXHIGHNY, 79.7% of markets profitable, day-clustered t = 2.02 — with a stated mechanism of
*thin volume -> less market-maker competition -> wider spreads -> liquidity provision pays.*

Two pre-registered tests, one narrow and one broad. **Both refuted it.**

## Test A — out-of-sample weather cities: REFUTED

Six fresh cities, gates fixed in advance, strict parameter lock (identical fee model, P&L
arithmetic, estimator):

| city | raw mean | James-Stein shrunk |
|---|---|---|
| KXHIGHCHI | -2.29c | -1.95c |
| KXHIGHLAX | +0.37c | -0.62c |
| KXHIGHMIA | -1.00c | -1.31c |
| KXHIGHDEN | -4.16c | -2.89c |
| KXHIGHAUS | -1.39c | -1.50c |
| KXHIGHPHIL | -1.22c | -1.41c |

**Pooled: -1.61c/contract (60 city-day units), t = -3.92, p = 0.0001.** Zero of six cities
positive. Every gate failed — W1 (significance), W4 (majority + veto), W5 (decay), W6 (fill
realism, both readings).

The sign did not merely fail to replicate, it **inverted**: in-sample +1.15c became
out-of-sample **-1.61c, significantly negative**. Makers in weather markets lose money.

## Test B — the mechanism across 42 series: REFUTED

If the edge came from thin liquidity, maker edge must fall with volume **everywhere**, not just
in weather. Tested across **42 series spanning 10 categories and ~4 orders of magnitude of
volume** (558 to 2.58 M median contracts):

```
OLS   maker_net ~ log10(median volume)
      slope = -0.105c per decade    t = -0.15    p = 0.88    R^2 = 0.001    n = 42
```

**No relationship whatsoever.** R^2 = 0.001. Leave-one-category-out is unstable in *sign*
(dropping Commodities, Economics or Sports flips the slope positive), failing M2 as well.

Per-series edges range from **+9.72c to -13.54c with no volume pattern** — the spread is noise,
not structure. That is itself informative: if series-level maker edge estimates are this noisy at
30-60 markets each, the original +1.37c weather reading was almost certainly noise too, which is
exactly what Test A found.

## What this kills, and what survives

**Dead:** the weather maker edge; the liquidity-provision explanation; and the earlier suggestion
that "we have been trading the wrong side of the weather market." That inference was built on the
in-sample number and does not survive.

**Survives (and is now better evidenced):** **takers lose.** Measured with settlement ground
truth on 1.49 M real executed trades: MLB -1.41c, crypto -0.77c, weather -2.84c per contract. And
makers earn positive **gross** in the original three series while still losing **net** in two of
three — the spread they capture generally does not cover the fee. The venue's fee is the binding
constraint, on both sides.

## Why the in-sample result looked real

Three compounding effects, all now documented:

1. **Selection.** Weather was the best of three series — Pav ([2606.01650](https://arxiv.org/abs/2606.01650))
   shows the selected max is an upward-biased estimate.
2. **Clustering.** 59 markets were only 10 independent days (strike ladders share one temperature
   outcome). Correcting the unit left t = 2.02, which at 9 df is p ~ 0.07 — never significant.
3. **Small effective n.** Ten days is not enough to distinguish +1.15c from zero given a per-day
   sd of 1.79c.

The pre-registration is what caught it. The gates were written before the out-of-sample data was
scored, committed with a sha, and not rewritten when they failed.

## Process note

An earlier draft of these gates invented every threshold (t >= 2.5, 65% of markets, +0.5c). They
were replaced with protocol elements from the literature — Pav for post-selection shrinkage, the
AlgoXpert IS-WFA-OOS protocol ([2603.09219](https://arxiv.org/abs/2603.09219)) for staging,
parameter lock, majority-pass and catastrophic-veto. The refutation is cleaner for it: the gates
were not mine to bend.
