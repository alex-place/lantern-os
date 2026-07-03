feat(kalshi): fit the weather-oracle distribution constants from IEM data (#1871, part 1)

The oracle's four distribution parameters (`COOL_BIAS_F`, `REGRESSION_K`, `SIGMA_*`,
`CEILING_TABLE`) were hand-anchored guesses — the one synthetic part of an otherwise
externally-grounded model. This lands the machinery to MEASURE them:

- `scripts/fit-weather-oracle-params.js` — pulls IEM forecast→settlement pairs (NBS MOS +
  NY_ASOS), fits coolBias/regressionK (OLS of residual on positive anomaly), sigma-by-lead
  (residual std), and the ≥100°F ceiling (empirical tail, supported bins only), and writes
  `data/kalshi/weather-oracle-params.json`. Pure fit functions, unit-tested.
- `kalshi-weather-edge.loadParams()` — reads that file with **per-field fallback** to the
  original constants. No file present (the repo default) ⇒ behavior byte-identical to before;
  an invalid/mis-shaped field silently keeps its default, so a bad file can't break the oracle.
- Corrects the research note's IEM blocker: the MOS backend is `/cgi-bin/request/mos.py`
  (`api/1/mos.json` 404s).

First measured fit (2021–25 summers, n=1825) is reported in
`docs/research/2026-07-02-weather-oracle-constant-fit.md`. It found the `coolBias` SIGN is
likely flipped and sigma over-estimated — but on PROXY sources (MOS point + ASOS max, not the
gridded-NWS + NWS-CLI pipeline KXHIGHNY settles on). With live weather-edge trading enabled,
promotion to the live params file is deliberately GATED on re-fitting against the true
settlement source and an out-of-sample RPS/PIT win (kalshi-weather-verify, #1895). This PR ships
the mechanism only; the oracle keeps running on defaults.

PROMOTION VALIDATION (scripts/validate-weather-oracle-fit.js): re-fit against the AUTHORITATIVE
NWS CLI settlement (IEM json/cli.py — the KNYC daily-high KXHIGHNY settles on) and scored
out-of-sample with kalshi-weather-verify (#1895). Trained 2021–23, tested 2024–25 (n=723):
fitted-on-CLI cuts mean RPS 0.0504→0.0309 (−39%) and PIT χ²ᵣ 94→6 — the default constants are
badly mis-calibrated; the sign flip is real (coolBias −1.55) and even larger against CLI (ASOS
max ran 0.89°F BELOW CLI). STILL not promoted: the fit's forecast leg is NBS MOS but the live
deck serves the gridded NWS forecast (kalshi-nws.getForecastHighs) — a train/serve skew that
would mis-apply the −1.55°F correction. Promotion path documented in the research note; gate is
an OOS win with the SERVED forecast source. Oracle stays on defaults.

Verify: fit suite (9 cases) + validate suite (`test/validate-weather-oracle-fit.test.js`, 4
cases: CLI parse, forward model normalization + ceiling + sign, RPS ranking). Weather-edge
self-test still PASS on defaults. Strengthens the **Reason** + **Verify** stages.
