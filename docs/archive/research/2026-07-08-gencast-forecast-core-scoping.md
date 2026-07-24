# Scoping — GenCast-class forecast core for the weather oracle (#2239)

**Status:** scoping only (no code). **Date:** 2026-07-08.
**TL;DR:** The hypothesis is worth testing but **GenCast itself is the wrong place to start** — it's
infra-heavy and not locally runnable, and it is *not needed* to test the kill-risk. Start with a
**free calibrated-ensemble proxy** (NWS NBM probabilistic Tmax or ECMWF open ENS). If even a good
proxy can't beat the *market-implied* distribution after fees on settled days, GenCast won't either
— kill it for ~a few days of work instead of standing up a diffusion-ensemble pipeline. Sequence
after the current oracle has settled outcomes (#2218); the offline calibration backtest can run now.

## 1. What the issue asks
Replace the oracle's hand-tuned core (NBS-MOS point forecast + Gaussian + ≥100 °F ceiling hack in
`lib/kalshi-weather-edge.js`) with a **calibrated full ensemble** that emits a
bucket distribution natively — the exact shape a temp-ladder contract needs — and see if it prices
the ladder (especially the thin ≥100 °F tail) better than both climatology and the current oracle,
*and* better than the market.

## 2. The one insight that reshapes the scope
**The expensive component (GenCast) is not required to test the hypothesis.** The kill-risk — *does
a well-calibrated ensemble beat the market's implied distribution after fees?* — is answered by **any**
well-calibrated ensemble. GenCast's edge over ECMWF is marginal (it wins ~97% of targets, but by
small CRPS deltas); the market almost certainly already embeds ECMWF/NWS ensembles. So:

- If a **free ensemble proxy** already beats the market → promising; *then* GenCast might add a sliver.
- If a free proxy **doesn't** beat the market → GenCast (a marginal improvement on the same physics)
  won't cross the line either. **Kill cheaply.**

This makes GenCast a *Phase 3+* concern, not the starting point.

## 3. Feasibility of GenCast locally — realistic answer
- GenCast (arXiv:2312.15796): ~0.25° global, 15-day, **50-member diffusion ensemble**; JAX; trained/
  run on Google TPU. Each member is many diffusion denoising steps; 50 members × global grid is a
  serious inference load. Inputs are ERA5/GFS analysis fields.
- Local box is a ~12 GB consumer GPU ([[project_ibkr_paper_trading]] / training notes). **GenCast
  inference is not locally feasible** there. GraphCast (deterministic) is borderline; GenCast
  (ensemble diffusion) is not.
- Paths if we ever want *actual* GenCast: rented GPU/TPU (Kaggle/Lightning, see
  [[project_gpu_training_accounts]]), or consuming **pre-computed** GenCast outputs for the backtest
  window if published, or WeatherBench-2 hosted forecasts. All are Phase-3 options, not Phase-0.

## 4. The cheap proxy (Phase 0 input)
Pick one, in order of least effort:
1. **NWS NBM probabilistic Tmax** — the National Blend of Models already publishes percentile /
   probabilistic max-temp guidance per station. The oracle *already* pulls NBS-MOS (an NBM cousin),
   so this is the smallest jump: use NBM's probabilistic Tmax as the ensemble distribution directly.
2. **ECMWF open ENS** (open-data API) — free gridded ensemble; downscale to the station. More work,
   closer to "a real ensemble," and it's what the market likely prices off.
Either yields a per-day member set → histogram over the contract ladder = the bucket distribution.

## 5. Settlement-station constraint (from the ForecastEx probe, #2216)
The ensemble must be downscaled/calibrated to the **exact settlement station**, and the two venues
**differ**: Kalshi `KXHIGHNY` settles on **KNYC** (Central Park); ForecastEx `UHLGA` settles on
**KLGA** (LaGuardia). A KNYC-calibrated distribution is wrong for the ForecastEx contract. Any
forecast core is per-station, exactly as the current oracle is (`kalshi-mos.js` station=KNYC).
Composes with #2220 (multi-city) — a city is data, not code.

## 6. Measurement protocol (reuses the existing stack — no new grading infra)
Per backtest day, per station: `{ ensemble member highs, settled high (NWS CLI archive), contract
ladder, market asks }` → ensemble → **bucket distribution**. Then:

| Gate | Test | Tool that already exists |
|---|---|---|
| **G1 calibration** | proxy RPS/PIT-χ²/reliability **<** current oracle **<** climatology, out-of-sample | `lib/kalshi-weather-verify.js` (RPS/PIT/reliability, n≥20 bar) |
| **G2 beats-market** | trading the proxy dist vs real asks nets **+EV after fees** AND beats trading the oracle's dist | `robustEdgeReport` (fee-aware band-robust EV) + `econ-nowcast-edge.js` `measureEdge` (beats-market gate) |
| **G3 promote** | only if G1 **and** G2 pass on held-out days | forecast-core adapter behind a flag in `kalshi-weather-edge.js`; A/B in the deck (#2217) |

Data notes: settled highs are freely archived (NWS CLI / IEM) → **G1 is backtestable now**. Historical
**market asks** are the hard input (Kalshi/ForecastEx don't give deep free history) → G2 needs either
a forward-collected ask ledger (rides #2218) or a purchased/scraped history. This is the real gating
dependency, not compute.

## 7. Phased plan + rough effort
- **Phase 0 — adapter spike (~1–2 d):** `ensemble → bucket distribution` adapter + pull a proxy
  (NBM prob Tmax) for one station/window. Deliverable: a distribution object `kalshi-weather-verify`
  can grade. *No trading.*
- **Phase 1 — calibration backtest (~2–3 d):** grade proxy vs oracle vs climatology on held-out
  settled highs. **GATE G1.** Expected: a real ensemble likely beats the Gaussian+ceiling hack on
  calibration (that hack is admittedly crude) — but that's *necessary, not sufficient*.
- **Phase 2 — beats-market backtest (~3–5 d + data):** the kill-risk. Needs historical asks.
  **GATE G2.** Honest prior (matches the issue + the econ-nowcast discipline): **likely thin/no edge**
  vs a liquid market that already embeds ensembles — *except possibly the ≥100 °F ceiling tail*, where
  the market's naive tail may misprice and a calibrated ensemble could genuinely differ.
- **Phase 3 — GenCast proper (only if G1+G2 pass):** rent compute or consume hosted GenCast outputs;
  re-run G1/G2 to see if GenCast beats the free proxy by enough to justify its cost.

## 8. Dependency ordering / prioritization (the honest strategic call)
- **Blocked-ish on #2218:** G2 needs settled outcomes + the ask ledger. Per the profitability review
  ([[project_weather_oracle_measurability]]) there are still ~**0 settled trades** — the current
  oracle has not shown it beats the market *at all*. Swapping the forecast core optimizes a component
  of a system not yet shown to be profitable.
- **Rational sequence:** (a) get the current oracle to n≥20 settled (prove/disprove the *basic* edge
  and stand up the ask ledger); (b) run G1 offline **now** (settled-high archive is free) to see if a
  better core is even worth it; (c) run G2 once asks exist; (d) GenCast only if G2 clears with a proxy.
- **Recommendation:** **do not prioritize #2239 yet.** It's a legitimate research spike, but it's
  third in line behind "does the edge exist at all" (#2218 data) and "is the forecast core even the
  bottleneck" (G1). When picked up, start at Phase 0 with the **NBM proxy**, not GenCast.

## 9. What "done scoping" unlocks next (if greenlit)
The one concrete first artifact is the **Phase-0 adapter + G1 harness** — an `ensemble → bucket dist`
function graded by `kalshi-weather-verify`, mirroring how `econ-nowcast-edge.js` was built as a
measurement harness before any trading. I can scaffold that on request; it's ~a day and produces a
real G1 number against the current oracle without touching live trading or GenCast.
