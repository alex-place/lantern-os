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

- trading/options-shadow: **deep-OTM focus — strike LADDER.** The shadow now records
  every depth of `OPTIONS_SHADOW_LADDER` (default `0.25,0.5,1,1.5,2` % OTM) each eligible
  night — one real contract + real quote per leg — and `summarize()` reports expectancy
  **per depth**, so the deep-OTM lottery profile (~1–5% win rate, rare huge payoffs) is
  judged on its own measured expectancy, never its win rate. A 10y gap study found
  near-OTM EV clearly negative but 1.5–2% OTM *ambiguously positive on a 4–8-event tail*
  (spread costs halve it) — exactly what only real nightly premiums can settle. Also fixed
  an expiry bug: "tomorrow" was computed in UTC, so a late-evening run skipped Friday's
  expiry and priced weekend time value; `nextTradingDayET()` now picks the ET-correct next
  trading day. Live-verified: 5-leg SPY ladder with real bid/asks (741→754 strikes).

- trading/options-shadow: **PENNY mode** (operator strategy) — each eligible night, find
  the **first strike whose ask ≤ 1¢** via a one-call chain snapshot, and take it **only
  when tonight's measured vol says the strike is reachable** (distance ≤
  `OPTIONS_SHADOW_PENNY_MAX_SIGMA`=3 nightly sigmas — the penny-strike distance is the
  market's implied-vol gauge, so this buys exactly the nights where our vol read exceeds
  the market's). Exit: an intraday watcher **sells the moment the bid is > 1¢**
  (`OPTIONS_SHADOW_PENNY_EXIT_BID`=2¢ = +100% gross), else settles at expiry (−100%).
  Entries priced at the ASK, exits at the BID — the honest sides of a 1¢ market. Ledger
  rows carry `depth:'penny'` + `sigma`/`dist_pct`, so the penny book is judged on its own
  measured expectancy. Live-verified: real chain snapshot picked SPY 756 (2.31% OTM) at
  ask $0.01.
