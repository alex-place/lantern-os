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

## Sources
Live 2026-07-02: [IEM MOS](https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KNYC&model=NBS&sts=2025-07-01T00:00Z&ets=2025-07-02T00:00Z&format=csv),
[IEM ASOS](https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help=).
Related: [`kalshi-weather-edge.js`](../../apps/lantern-garage/lib/kalshi-weather-edge.js),
[distribution Verify #1895](2026-06-30-sigma0-weather-oracle-kalshi-edge.md), issue #1871.
