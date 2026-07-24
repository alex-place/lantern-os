---
author: Claude (Opus 4.8, backend agent)
created: 2026-06-30
status: research + offline probe landed; live wiring is the open handoff
loop_stage: Reason + Verify (extends the Convergence Core; not a new subsystem)
---

# Σ₀ Weather Oracle — a Kalshi daily-high edge, grounded in the settlement source

## Thesis

Kalshi **KXHIGHNY** settles on the **NWS Daily Climatological Report for Central
Park (KNYC)**. The prediction target and the settlement source are the *same
external measurement* — which makes this the cleanest Σ₀-grounded application we
have. It closes the one open red-team gap in the collapse machinery,
[ANTI-COLLAPSE-HARDENING.md](../ANTI-COLLAPSE-HARDENING.md) **G1**
(observation-channel poisoning: the NIS canary trusting an unauthenticated `y`),
*by construction* — the observation the belief-loop consumes IS the authenticated
settlement value.

This is **not** a new subsystem. It is the Reason+Verify stage of the existing
Convergence Core applied to a weather Task, feeding the existing
`kalshi-suggest` / council EV gate.

## Loop mapping

| Stage | Mechanism | Status |
|---|---|---|
| Observe | NWS gridpoint forecast (OKX 34,45) + live KNYC ASOS obs | adapters (need egress) |
| Remember | PCSF manifest ranks forecast sources; CSF stores forecast→verification scalar pairs | reuse formats |
| Reason | calibrated bucket distribution — [`experiments/kalshi_weather_edge.py`](../../experiments/kalshi_weather_edge.py) | **landed** |
| Verify | band-robust edge vs live market (net of fees) + NIS canary + online-conformal coverage | landed + open |
| Converge | ConvergenceRecord per market; settle via [`kalshi-convergence-outcomes.js`](../../lib/kalshi-convergence-outcomes.js) | reuse |

## Measured calibration (the "reverse-in")

All pulled live 2026-06-30 — replaces earlier *assumed* numbers with measured ones:

| Fact | Value | Source |
|---|---|---|
| KNYC daily normal high, Jul 1 | **83.8 °F** | NCEI 1991–2020 normals |
| Early-July daily-high 90th percentile | **~92 °F** (avg ~84) | WeatherSpark |
| Record high (any July) | 106 °F (1936-07-09) | NWS OKX extremes |
| **≥100 °F days, full record** | **60 in 157 yrs; ~5 since 2001** | NWS OKX 100-Degree-Days |
| **Last 100 °F at Central Park** | **2012-07-18** (2019/22/25 stalled at 99) | NWS OKX 100-Degree-Days |

**The key finding — the ≥100 °F ceiling.** Central Park crossing 100 is a
~once-per-5-years modern event that *hasn't happened since 2012* despite repeated
heat waves. The naive Gaussian upper tail (which put ≥100 at ~8% on a 96 °F
forecast and ~30–50% on a 101–102 °F forecast) is **refuted**. The probe caps the
≥100 buckets at a forecast-conditional ceiling and piles the excess mass at 98–99,
reproducing the observed hard ceiling. Corollary: the market prices the
**forecast**, not climatology — correctly.

## Band-robust edge — why point estimates lie

A point-estimate "edge" that flips sign when the day turns out more/less
predictable is **noise**, not signal — that is exactly how the naive model
hallucinated a +13¢ edge on the routine day. The probe therefore reports an edge
only if it **survives the whole calibration band** (σ and downshift uncertainty).
The band is also the seam where a *measured* forecast-conditional bias plugs in
and collapses the band to a line (see Handoff).

## Two-certificate Verify (the Σ₀ tie-in)

- **Internal — NIS canary** ([`surprise.py`](../../src/cio_sde/surprise.py)):
  `νᵀS⁻¹ν`, belief self-consistency with the latest ob. HEURISTIC (trusts its
  input — G1, closed here by the authenticated NWS feed).
- **External — online conformal coverage:** distribution-free, finite-sample
  coverage under shift (ACI/FACI/SAOCP). [arXiv:2606.19642](https://arxiv.org/abs/2606.19642)
  applies conformal to probabilistic AI weather forecasts. This is the *external
  audit on the NIS* — it catches the "calm while wrong" failure the certificate's
  §4 is built for.

## Results (2026-06-30, live)

- **Jul 1 (forecast 96 °F):** `no certified edge` — the market is efficient to
  calibration resolution. The point-estimate "NO 94-95 (+11¢)" has worst-case
  only +3¢ and does **not** survive the band. Calibration correctly *deleted a
  fabricated edge*.
- **Jul 3 (forecast 102 °F; market not yet open):** robust **FADE on ≥100** —
  `NO 100-101 (≥+27¢)` and `YES 98-99 (≥+24¢)` survive the whole band. The ceiling
  caps ≥100 at ~8–13% against a forecast-anchored price; the mass is at 98–99.
  Ready-to-fire when the market opens.

## Open handoff (needs network egress — the app server / in-app model)

This sandbox's Bash has **no egress** (DNS hangs); WebFetch is proxied. So the
live legs run on the server that already polls Kalshi:

1. **Observe adapters** — live NWS forecast + Kalshi prices + KNYC obs.
2. **IEM/MOS forecast-conditional pairing** — pull archived NWS/NBM forecast
   highs vs settled KNYC highs on 98–102 °F-forecast days; this *measures* the
   `CEILING_TABLE` and downshift and collapses the band to a line. Source:
   `mesonet.agron.iastate.edu` (the `api/1/mos.json` request format needs
   correcting — the naive form 404'd).
3. **Wire** the band-robust `actionable` output into `kalshi-suggest` / the
   council EV gate; settle via `kalshi-convergence-outcomes.js`; log
   ConvergenceRecords to `data/convergence/weather-edge-records.jsonl`.
4. **Intraday Bayesian update** — as KNYC obs accumulate, the
   [`cio_sde`](../../src/cio_sde/engine.py) Kalman posterior sharpens and the NIS
   canary fires if reality diverges from the forecast prior.

## Honest scope

- `CEILING_TABLE` + downshift are measured-*anchored estimates*; the
  forecast-conditional bias is inferred, not yet directly paired (handoff item 2
  is the fix — until then, `confidence ≤ 0.6` on the records).
- Conformal gives **marginal**, not conditional, coverage.
- Fees + a liquid market mean the routine day has no edge; the **extreme-forecast
  days are where mispricing is likeliest** — thin books, record framing, largest
  model disagreement.

## Sources

Live/measured: [NCEI KNYC normals](https://www.ncei.noaa.gov/access/services/data/v1?dataset=normals-daily-1991-2020&stations=USW00094728&startDate=2020-06-25&endDate=2020-07-05&dataTypes=DLY-TMAX-NORMAL&units=standard&format=json),
[NWS Central Park 100°F record](https://www.weather.gov/media/okx/Climate/CentralPark/100DegreeDays.pdf),
[WeatherSpark NYC July](https://weatherspark.com/m/147190/7/Average-Weather-in-July-at-New-York-City-Central-Park),
[NWS forecast OKX 34,45](https://api.weather.gov/gridpoints/OKX/34,45/forecast),
live [Kalshi KXHIGHNY](https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXHIGHNY&status=open).
Method: [conformal UQ for AI weather (2606.19642)](https://arxiv.org/abs/2606.19642),
[collapse certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md), [G1](../ANTI-COLLAPSE-HARDENING.md).
