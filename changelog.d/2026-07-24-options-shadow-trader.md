### Added

- trading: **asymmetric-options SHADOW trader** (`lib/options-shadow.js`, loop stage:
  Verify). Implements the operator's thesis — buy a slightly-OTM next-day CALL at the
  close on Mon–Thu nights that are trend-aligned + measurable-vol, sell at the open,
  accepting a low (~30–40%) win rate for convex payoffs — but in **measurement-only
  shadow mode**: it selects a real contract from the real Alpaca options chain (free
  indicative feed), records real entry/exit quotes to `options-shadow.jsonl`, and
  reports **measured** win rate / expectancy with a Σ₀ verdict. A win rate is an
  outcome, not a parameter — the module never targets one, and it **refuses arming**
  until expectancy is measured positive over ≥30 nights (`insufficient_data` →
  `negative_edge — do NOT arm` / `positive_edge_candidate — needs OOS + operator
  approval`). Places NO orders anywhere. Endpoints: `GET /api/trading/options-shadow`
  (status + measured stats), `GET …/probe` (what it would trade right now — verified
  live: real SPY chain, correct weekend-skipping expiry, 0.25%-OTM strike, real
  bid/ask), `POST …/tick`. Driven by the autoscan loop (fail-soft, self-throttled to
  its 15:45–15:59 / 09:31–09:50 ET windows). Config: `OPTIONS_SHADOW`,
  `OPTIONS_SHADOW_SYMBOL/OTM_PCT/RISK_PCT/VOL_MODE`. Pure gate/strike/verdict logic
  covered by `test/options-shadow.test.js` (7 tests).
