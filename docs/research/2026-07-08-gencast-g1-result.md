# GenCast Phase-0 — Gate G1 result (#2239)

**Status:** measured (real data). **Date:** 2026-07-08. **No trading.**
Runner: `experiments/gencast_g1_backtest.js` · core: `lib/ensemble-forecast-core.js`.

## What was run
A **wired** NBM proxy feed + the G1 calibration backtest from the scoping (#2280):
- **Forecast:** NBS/NBM MOS for **KNYC (Central Park)** from IEM. A day-ahead **time-lagged
  ensemble** — each prior-day model *run* forecasting the target day contributes one member
  (its max-over-day `tmp`). ~12 members/day.
- **Settled:** ASOS hourly max (`NYC`/`NY_ASOS`) as the settled daily high (NWS-CLI proxy).
- **Grading:** each model's bucket distribution over a fixed 2 °F ladder, scored with the live
  verifier's RPS (`kalshi-weather-verify`) — ensemble vs the incumbent fitted oracle vs flat
  climatology, on settled highs.

## Result — the fitted oracle beats the raw ensemble (both months)
| Month | days | **ensemble RPS** | **oracle RPS** | climatology | beats oracle? |
|---|---|---|---|---|---|
| 2025-07 | 31 | 0.0608 | **0.0431** | 0.2391 | ❌ no |
| 2025-08 | 31 | 0.0310 | **0.0176** | 0.2718 | ❌ no |

Both models crush climatology (real skill), but the **crude Gaussian+ceiling oracle is the
better-calibrated forecaster** in both months. **G1 verdict: `no-improvement`.**

## Why (and the honest caveat)
The oracle wins because it is **bias- and width-fitted** to KNYC (coolBias/regression/σ over
n=1818 settled days): it already knows the MOS→settlement bias and the right spread. The
time-lagged ensemble here is **raw** — uncalibrated, and time-lagging **over-spreads** (members
span different lead times). So a fitted-but-crude model beats an unfitted-but-physical one.

This is the **cheap proxy**, so the result is a *lower bound*, not a verdict on GenCast:
- It **does** kill the naive version of the hypothesis: a raw ensemble does **not** beat the
  current oracle, so the forecast core is **not obviously the bottleneck** — the oracle already
  extracts most of the available calibration skill.
- It does **not** prove a *calibrated* ensemble (GenCast, bias/width-corrected the same way the
  oracle is fitted) couldn't win. That's the only fair next test.

## Recommendation
- **Do not pursue GenCast on forecast-quality grounds yet.** The bar is a *fitted* oracle, and
  raw ensemble skill doesn't clear it. GenCast's marginal edge over ECMWF is unlikely to flip a
  gap this size once the oracle's calibration is accounted for.
- **If pursued anyway,** the fair G1 is: fit the ensemble's bias + spread (same as the oracle)
  on a train split and re-grade out-of-sample. Only if a *calibrated* ensemble beats the fitted
  oracle is a market test (G2) worth it — and G2 still needs the historical ask ledger (#2218).
- Net: this measured G1 **de-prioritizes #2239** on evidence, cheaply, exactly as the scoping
  intended — before any GenCast infrastructure.

*(Reproduce: `node experiments/gencast_g1_backtest.js 2025-07` — writes
`data/kalshi/gencast-g1-<month>.json`, gitignored.)*
