feat(router): add the "numeric" time-series-forecasting route (TSFM specialist)

Wire a first-class numeric/time-series-forecasting intent into both routers so a
"forecast the price series" ask resolves to a dedicated time-series foundation
model (Kronos / Chronos-Bolt lineage) instead of a chat/coder model.

- `ouro-router.js`: add `numeric` to `TASK_TYPES` + a classifier bullet, kept
  DISTINCT from `trading` — forecasting a series (numeric) vs a buy/sell decision
  (trading).
- `local-model-registry.js`: register the `keystone-tsfm` specialist
  (`taskTypes:["numeric"]`, `selfConverges:true` so it is never wrapped in
  loopedReason(), `verified:false`, `vramGB:2`, endpoint `TSFM_ENDPOINT`); mark
  `numeric` STRICT so no general coder widens into the forecasting route (the
  number-tokenization bottleneck — a text model shreds "$64,201" into noise).
- Route is DARK until a serving adapter answers at `TSFM_ENDPOINT` (:11436); like
  the PLT :11435 shim, if absent the chain resolves but the caller falls back to
  cloud rather than routing a wrong model. `provider-router.js` needs no change —
  an unknown taskType already falls back to the `default` cloud chain.
- Grounding: `verified:false` per the External Reality Rule — no bias-mitigated
  walk-forward result beating a naive baseline yet (TSFM/LLM "alpha" routinely
  vanishes under honest backtests, arXiv 2505.07078). Flip true only on a
  reproduced walk-forward win on our Kalshi/KNYC OHLCV.
- Tests: +6 numeric-route cases in `local-model-registry.test.js` (sole numeric
  lead, STRICT no-widening, no leak into coding/reasoning/default, single-pass
  contract, resolveLocalLead path, VRAM gate) + a `TASK_TYPES` guard test. All
  green. The 10 pre-existing coding-lead failures in that suite are stale #2171
  (qwen-is-verified-lead) expectations — present on master (12/22), tracked
  separately, not touched here.

Follow-on: the TSFM serving adapter + a `forecast_timeseries` native tool, gated
on the walk-forward-vs-naive harness. Loop stage: Reason.
