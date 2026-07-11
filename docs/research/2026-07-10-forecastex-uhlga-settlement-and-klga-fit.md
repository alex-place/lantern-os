# ForecastEx UHLGA: settlement grounded + KLGA oracle fit (#2217)

**Date:** 2026-07-10 · **Method:** primary regulatory documents + the venue's own public
data feed + IEM history; measured fit with OOS promotion gate. Follows and partially
supersedes [2026-07-08-forecastex-probe-findings.md](2026-07-08-forecastex-probe-findings.md).

## TL;DR

1. **PROVEN** — ForecastEx's only live NYC daily-high product is the U-series **`UHLGA`**,
   settling on **Weather Underground's** daily high for the LaGuardia-coded region. The
   probe's station inference was right; its "confirm in writing" step is now done. The
   DH-series (NWS-CLI-settled, NYC = Central Park) that the IBKR Campus article describes
   is **no longer listed** (0 DH products in the venue's product summary).
2. **MEASURED** — venue settlement ≡ `round(max METAR tmpf)` for LGA: **14/14** settled
   days match (Jun 2026). The NWS CLI daily max disagrees **6/13** days, by up to **4°F**
   (2026-06-12: WU 94 vs CLI 98). The CLI is the **wrong settled leg** for this venue.
3. **NEW CAPABILITY** — the venue publishes its full board publicly:
   `https://www.forecastex.com/api/download?type={prices|pairs|summary}&date=YYYYMMDD`
   (EOD prices *including settlement values*, no auth, dates ≥ 2026-02-03). This unblocks
   the Observe leg **without** the IBKR EC entitlement that blocked #2216.
4. **MEASURED** — the KLGA station fit (the "re-fit, not fee swap" the probe demanded):
   n=1825 pairs, **OOS RPS 0.0356 (fitted) vs 0.0508 (defaults), 30% gain**, promoted to
   `data/kalshi/weather-oracle-params-klga.json`.
5. **HONEST NEGATIVE** — `ceilingSupport: []`: five summers of KLGA data contain too few
   99–104°F forecast days to fit a ≥100 ceiling. **The Kalshi ≥100-fade edge does not
   transfer as fitted.** Any UHLGA edge must be found forward, against live prices.

## 1. Settlement: primary evidence

- **CFTC 40.2(a) product filing (2026-01-23,
  [ptc01232637912.pdf](https://www.cftc.gov/sites/default/files/filings/ptc/26/01/ptc01232637912.pdf)),
  Appendix A "U Contract Terms and Conditions":**
  - Event question: *"Will the [highest/lowest/average] temperature in [region]
    [exceed/be below] [##] F on [date]?"* → **exceed semantics**.
  - Product code: **`U[H/L/A][three letter region code]`** → `UHLGA` = U·High·**LGA**.
  - *"Source Agency: Weather Underground"*; resolves on WU's *"final daily temperature
    values for the applicable station and date"* (the "High Temp / Actual" figure), once
    the first next-day observation publishes. Tick $0.01; binary $1.00/$0.00 settlement.
- **Venue product summary (public CSV, 2026-06-16):** 159 products; 24 `UH*` + 23 `UL*`
  temperature products; **zero `DH*`**. NYC appears only as `UHLGA`/`ULLGA`. The
  IBKR-Campus "NYC = Central Park" description applies to the DH-series generation and is
  stale for what actually trades.

Consequence (unchanged from the probe, now proven): Kalshi `KXHIGHNY` (KNYC/Central Park)
vs ForecastEx `UHLGA` (LGA) is a **station-basis pair, not an arb**. LGA runs systematically
warmer; `cross-venue-monitor.js`'s caveat stands.

## 2. Settlement semantics, measured against the venue's own numbers

From the public prices CSVs (settlement column), per contract date: `maxYes` = highest
threshold settling YES=1, `minNo` = lowest settling YES=0. On clean flips
(`minNo == maxYes+1`) the settled high is pinned exactly (strict-exceed ⇒ high = `minNo`).

Jun 3–16 2026, KLGA (14 clean days):

| Test | Result |
|---|---|
| implied high == `round(max METAR tmpf)` (IEM ASOS `LGA`, local day, incl. specials) | **14/14** |
| implied high == NWS CLI (`CLILGA`) daily max | **7/13** (CLI warmer by 1–4°F on the rest) |
| implied high == `maxYes` (i.e. "exceed" as ≥) | 0/13 → convention is strictly-greater |

The CLI↔WU gap is physical: the CLI max comes from the ASOS continuous (5-min) record and
catches spikes between reports; WU's "Actual" high tracks the METAR feed. Over summers
2021-2025 the gap averages **−0.89°F** (ASOS-max − CLI, n=463 shared days).

## 3. KLGA oracle fit (station-generic pipeline)

`scripts/validate-weather-oracle-fit.js` now takes `--mos-station --asos-station
--asos-network --settled cli|asos --normals-cli-year --out` (defaults reproduce the KNYC
run byte-identically; all pre-existing tests green). Normals come from the station's own
NWS CLI `high_normal` (NCEI 1991-2020; 363 days fetched, KLGA summer mean **84.2°F**).

Run: `--mos-station KLGA --asos-station LGA --settled asos --normals-cli-year 2025
--train 2021,2022,2023 --test 2024,2025 --promote --out
data/kalshi/weather-oracle-params-klga.json`

| | value |
|---|---|
| pairs | 1825 (train 1095 / test 730), summers 2021–2025, leads 0–7 |
| coolBiasF | **−0.928** (LGA settles ~0.9°F *warmer* than NBS MOS; same sign as the KNYC CLI fit's −1.432) |
| regressionK | 0 |
| σ nowcast / base / per-lead | 2.177 / 2.375 / 0.345 |
| OOS meanRPS fitted vs defaults | **0.0356 vs 0.0508 (−30%)** |
| OOS PIT χ² fitted vs defaults | **21.25 vs 81.75** |
| promotion gate | PASSED → params committed |

**Ceiling: `ceilingSupport: []`.** No 99–104°F forecast bin reached the 12-sample support
floor in five summers. `lib/forecastex-weather.js` therefore substitutes a **non-binding
ceiling** whenever the station fit carries none — the KNYC ceiling table (the entire Kalshi
edge) can never silently apply to LGA and fabricate a fade. `certified: false` until
forward verification.

## 4. End-to-end read-only smoke (plumbing, not signals)

Public prices (2026-07-09 file) → settled join `2026-07-08 high=87 (clean)` →
`thresholdBoard` 77..89 → 2°F ladder via cumulative differences → KLGA params + flat 1¢
fee through `robustEdgeReport`. The pipe composes. The "robust edges" it prints against
**EOD closes are artifacts** — closing prices on a same-day board already know the
outcome a morning forecast doesn't. Real evaluation needs day-ahead boards nightly
(available in this feed) or live intraday quotes (needs the EC entitlement).

## 5. What remains before any UHLGA trade

1. **EC entitlement** on a ForecastEx-permissioned IBKR account (#2216 found `STKNOPT`
   only) — human/IBKR action; nothing in code can fix it.
2. **Forward verification (paper):** nightly join — KLGA-params `calibratedDistribution`
   vs next-day board (from this feed) and vs `settledHighs` — accrue RPS/PIT + any
   robust-edge hit-rate to n≥20 before believing any edge. The feed's history
   (≥2026-02-03) also allows a retrospective day-ahead backtest first.
3. **Act path:** ADR-gated order code (order entry is intentionally absent from
   `ibkr-cpapi.js` per ADR-0019); scope-gate + kill-file discipline as on Kalshi.

## Evidence classes

- PROVEN: U-terms (CFTC filing), product list (venue CSV), exceed-strict convention.
- MEASURED: 14/14 ASOS-max settlement match; CLI divergence; fit + OOS numbers; −0.89°F
  ASOS−CLI history gap; feed reach (2026-02-03 probe).
- HEURISTIC: flat ~1¢/contract fee (spread-embedded; #2216's measurement still pending a
  permissioned account — `FORECASTEX_FEE_CENTS` overrides).
- UNIMPLEMENTED: deck wiring, forward-verification job, any order path.
