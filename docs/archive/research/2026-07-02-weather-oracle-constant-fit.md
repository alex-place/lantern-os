---
author: Claude (Opus 4.8)
created: 2026-07-02
status: pipeline landed + first fit measured; promotion to live GATED on settlement-source validation
loop_stage: Reason (fit the oracle internals) + Verify (measured vs reality)
---

# Σ₀ weather oracle — fitting the distribution constants from IEM (#1871, part 1)

## What this is

The oracle (`kalshi-weather-edge.js`) is a complete in-house predictive-distribution model, but
its four distribution parameters were **hand-anchored guesses**. This lands the machinery to
**measure** them from IEM forecast→settlement pairs, and reports the first real fit.

- `scripts/fit-weather-oracle-params.js` — pulls IEM data, fits, writes
  `data/kalshi/weather-oracle-params.json`. Pure fit functions, unit-tested.
- `kalshi-weather-edge.loadParams()` — reads that file with **per-field fallback** to the
  original constants. No file (repo default) ⇒ byte-identical to before.

**Corrected the research note's blocker:** the IEM MOS backend is
`/cgi-bin/request/mos.py?station=KNYC&model=NBS&…&format=csv`, not `api/1/mos.json` (which 404s).

## First fit (2021–2025 summers, NBS MOS forecast vs NY_ASOS settled max, n=1825)

| Param | Hand-tuned | Fitted | Reading |
|---|---|---|---|
| `coolBiasF` | **+1.2** | **−0.665** | sign FLIPPED — NBS runs ~0.67 °F cool vs the settled max, not 1.2 °F hot |
| `regressionK` | 0.06 | 0.047 | confirmed direction, milder shrinkage |
| `sigmaBaseF` (day-ahead) | 2.4 | 2.035 | day-ahead spread over-estimated |
| `sigmaNowcastF` (same-day) | 1.5 | 1.817 | same-day spread under-estimated |
| `sigmaPerLeadF` | 0.5 | 0.352 | error grows slower with lead |
| `ceilingTable` | default | **no support** | 2021–25 had no ≥99 °F forecast bins with ≥12 samples → default correctly RETAINED |

Per-lead support: lead 0/1/2/3 = 460/460/455/450 pairs.

## Why this is NOT promoted to live yet (the honest gate)

The fit uses **proxies, not the true settlement pipeline**:

1. **Forecast source** = NBS (NBM) MOS *point* forecast. The oracle's constants were meant for
   the *gridded* NWS forecast the deck consumes. A MOS point vs a gridded high differ.
2. **Settlement source** = NY_ASOS max-of-hourly `tmpf`. KXHIGHNY settles on the **NWS CLI**
   daily max for KNYC. CLI ≈ ASOS max but not identical (siting/rounding).

The `coolBias` **sign flip** is exactly the kind of surprising result that could be a real
signal *or* a proxy artifact (MOS point systematically below the max-of-hourly). With live
weather-edge trading enabled (1-contract, scoped), flipping the calibration sign on proxy data
would be **internal consistency over external reality** — the opposite of Σ₀.

**Promotion gate (before writing the live params file):**
- Re-pull the forecast leg from the **same gridded NWS source the deck uses**, and the settled
  leg from the **NWS CLI** product (IEM `clitable`/CLI JSON), not ASOS max.
- Re-fit; confirm the sign flip survives the true pipeline.
- Backtest the resulting distribution with `kalshi-weather-verify` (RPS/PIT/ECE, #1895) on
  held-out days; only promote if it beats the hand-tuned constants out-of-sample.

Until then the oracle runs on defaults (unchanged). Promotion is one command once validated:
`node scripts/fit-weather-oracle-params.js --years … && <verify> && commit the params file`.

## Promotion validation (2026-07-02) — against the TRUE settlement source

`scripts/validate-weather-oracle-fit.js` re-ran the fit with the **authoritative NWS CLI**
settled leg (IEM `json/cli.py` — the KNYC Daily Climatological Report `high`, exactly what
KXHIGHNY settles on), trained on 2021–23 and scored **out-of-sample** on 2024–25 with the
distribution-level Verify (#1895):

| | default constants | **fitted-on-CLI** |
|---|---|---|
| OOS mean RPS (2024–25, n=723) | 0.0504 | **0.0309** (−38.6%) |
| OOS PIT χ²ᵣ | **93.98** (wildly mis-calibrated) | 6.36 (mild) |
| coolBiasF | +1.2 | **−1.551** |

- **The sign flip is real and larger against CLI.** ASOS max − CLI high = **−0.89 °F** (CLI, the
  official settlement, runs *above* the ASOS max-of-hourly), so the ASOS proxy *understated* it;
  the true bias is ≈ −1.55 °F. NBS MOS **under-predicts** the KNYC CLI daily max by ~1.5 °F.
- The default constants are not just off, they are **badly mis-calibrated** (PIT χ² ≈ 94). The
  fitted set cuts OOS RPS by 39% and PIT χ² by 15×. Strong, out-of-sample evidence.

### Why it is STILL not promoted — the train/serve skew

The fit's forecast leg is **NBS MOS**; the live deck's forecast leg is the **gridded NWS
forecast** (`api.weather.gov/gridpoints/OKX/34,45`, via `kalshi-nws.getForecastHighs`). A −1.55 °F
correction measured against *MOS point* input would be **mis-applied** to *gridded-NWS* input if
the two forecast sources don't share MOS's cold bias (gridpoint highs often sit closer to the
official max already). Promoting on that skew is internal-consistency-over-reality — the failure
Σ₀ forbids, and it touches live (scoped) money.

**Correct promotion path (pick one, then `--promote`):**
1. **Align serving to the calibrated source** — switch the deck's forecast leg to NBS MOS
   (archivable *and* now calibrated), so train == serve. Cleanest; makes the −1.55 valid.
2. **Calibrate the served source directly** — accumulate paired (gridded-NWS forecast, CLI high)
   day-by-day forward (gridded NWS is not archived historically) until n suffices, then promote.

Either way, gate on `validate-weather-oracle-fit.js` showing the fitted set still beats default
OOS *with the served forecast source*. Until then the oracle runs on defaults.

## Promotion executed (2026-07-02) — path 1: align serving to NBS MOS

Took path 1. New `lib/kalshi-mos.js` is now the deck's forecast source
(replacing `kalshi-nws`), owning the **exact** forecast-high definition the fit used (fit/validate
tools import the pure helpers from it, so **fit == serve by construction**). Live probe confirmed
real output (2026-07-02: 7-2 100°F, 7-3 101°F).

With train == serve the OOS gate holds (fitted −39% RPS, PIT 94→6), so
`validate-weather-oracle-fit.js --promote` wrote `data/kalshi/weather-oracle-params.json`
(coolBiasF −1.43, regressionK 0.018, sigmaBaseF 2.11, sigmaNowcastF 1.84; ceiling kept). The
oracle now loads it (`params: fitted 2026-07-03`).

**Material behavior change (flagged for review).** The fitted calibration says NBS MOS runs ~1.4°F
cold vs the CLI, so on a 96°F forecast the model now centers ~98°F and will **trade mid-ladder
buckets** where the default (mis-calibrated) constants stood down. More accurate (the point of the
fit), but a real live shift. Guards: ships via **PR** (reversible — delete the file → defaults);
live placement still needs the stable box's `KALSHI_LIVE_SCOPE`, capped 1 contract; the paper
ledger + `kalshi-weather-verify` (#1895) keep grading it. The oracle **self-test now tests
DEFAULT_PARAMS logic** (param-injected), so a future re-fit can't silently break the smoke test.
Recommended: a short paper-observation window on real settled days before trusting the live leg.

## Sources
Live 2026-07-02: [IEM MOS](https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KNYC&model=NBS&sts=2025-07-01T00:00Z&ets=2025-07-02T00:00Z&format=csv),
[IEM ASOS](https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help=),
[IEM NWS CLI](https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year=2024).
Related: [`kalshi-weather-edge.js`](../../../lib/kalshi-weather-edge.js),
[`kalshi-nws.js`](../../../lib/kalshi-nws.js),
[distribution Verify #1895](../../research/2026-06-30-sigma0-weather-oracle-kalshi-edge.md), issue #1871.
