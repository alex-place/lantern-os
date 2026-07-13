feat(trader): ForecastEx NYC port grounded — KLGA oracle fit (30% OOS RPS gain) + public board reader

The #2217 port premise is now settled with primary evidence, and the station model
it actually needs is fitted, validated, and committed.

- **Settlement grounded (primary sources):** ForecastEx's only live NYC daily-high
  is the U-series `UHLGA` — CFTC 40.2(a) filing (2026-01-23) defines product code
  `U[H/L/A][region]` settling on **Weather Underground's** daily high for the
  designated station, and the venue's own product summary lists **zero** DH
  (NWS-CLI/Central-Park) products. Kalshi↔ForecastEx NYC is a *basis* pair
  (KNYC vs LGA), not an arb — confirmed, no longer inferred from symbols.
- **Settlement semantics measured:** exceed = strictly-greater; settled high =
  clean-flip threshold; equals `round(max METAR tmpf)` for LGA **14/14** settled
  days (Jun 2026). The NWS CLI disagreed 6/13 days (up to 4°F) → CLI is the wrong
  settled leg for this venue; ASOS-max is the right one.
- **Public data feed discovered:** `forecastex.com/api/download` serves the full
  board (EOD prices incl. settlements, pairs, product summary) with **no auth /
  IBKR entitlement**, dates back to ≥2026-02-03 — unblocks the Observe leg that
  the CPAPI EC-entitlement gap (#2216) had blocked. New `lib/forecastex-board.js`
  (pure parsing + fail-soft fetch, 9 tests).
- **KLGA oracle fit (the "re-fit, not fee-swap" the probe called for):**
  `validate-weather-oracle-fit.js` is now station-generic (`--mos-station
  --asos-station --settled cli|asos --normals-cli-year --out`; KNYC default path
  byte-identical, all existing tests green). KLGA run: n=1825 pairs (summers
  2021-2025), normals from the station's own CLI `high_normal`; **OOS fitted
  beats defaults RPS 0.0356 vs 0.0508 (30% gain), PIT χ² 81.75→21.25** →
  promoted to `data/kalshi/weather-oracle-params-klga.json`.
- **Honest ceiling result:** `ceilingSupport: []` — five summers give NO
  measurable ≥100°F ceiling for LGA, so the Kalshi ≥100-fade edge **does not
  transfer as fitted**. New `lib/forecastex-weather.js` venue registry forces a
  non-binding ceiling when the fit has none (the KNYC table can never leak in and
  fabricate an edge) and stays `certified:false` (7 tests).
- Remaining blockers are explicit: EC entitlement on a ForecastEx-permissioned
  IBKR account (human/IBKR action), forward paper verification, ADR-gated Act.

Research note: docs/research/2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md.
Loop stages: Observe (board feed) + Reason (station fit) + Verify (OOS gate, settlement joins).
