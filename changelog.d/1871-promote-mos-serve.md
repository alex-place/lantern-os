feat(kalshi): serve the weather-edge deck from NBS MOS + promote the fitted oracle constants (#1871)

Closes the fit loop by aligning the served forecast source with the calibration source so
train == serve, then promoting the data-fit constants (they beat the hand-tuned defaults 39% on
out-of-sample RPS, PIT χ² 94→6 — see the research note).

- New `lib/kalshi-mos.js` — NBS (NBM) MOS forecast adapter, now the deck's forecast source
  (replaces `kalshi-nws`). It owns the canonical MOS forecast-high definition; the fit/validate
  scripts import the pure helpers from it, so the live deck and the calibration use one identical
  definition. Cached ~30min, fails soft to "stand down".
- `data/kalshi/weather-oracle-params.json` — the promoted fit (NBS MOS → NWS CLI, all summers):
  coolBiasF −1.43 (NBS runs ~1.4°F cold vs the CLI; the hand-tuned +1.2 had the sign wrong),
  regressionK 0.018, sigmaBaseF 2.11, sigmaNowcastF 1.84; ceiling retained (no tail support).
- `kalshi-weather-edge.js` — calibration functions now accept an explicit `params` arg
  (defaulting to the loaded params). The self-test validates DEFAULT_PARAMS *logic*, so it is
  independent of the deployed fit and a future re-fit can't silently break it.

MATERIAL BEHAVIOR CHANGE: the fitted calibration centers ~1.4°F warmer, so the model now trades
mid-ladder buckets where the mis-calibrated defaults stood down. Reversible (delete the params
file → defaults); live order placement still gated by the stable box's KALSHI_LIVE_SCOPE, capped
at 1 contract; paper ledger + kalshi-weather-verify (#1895) keep grading it live.

Verify: oracle self-test PASS (fitted params present, tests DEFAULT logic); new kalshi-mos test
(3 cases) + fit (9) + validate (4) suites pass; live MOS probe returned real KNYC highs. The
promotion ran through the OOS gate (validate-weather-oracle-fit.js --promote). Strengthens the
**Observe** (calibration-matched forecast) + **Act** (calibrated sizing) stages.
