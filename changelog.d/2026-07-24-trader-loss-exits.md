### Fixed

- trading/auto-trader: **losing positions are now actually cut.** A user's paper book had
  longs down −8% to −17% that the autopilot never exited. Three defects fixed:
  1. **The autopilot wasn't managing the account at all.** The autoscan loop enumerated
     accounts only by per-user credential *file*; the common single-operator setup runs on
     Alpaca *server env keys* under the id-less `local-owner` identity (no file), so it was
     invisible — no stops, no exits ever ran. `routes/trading.js` now includes
     `local-owner` when the login gate is off (local/preview), deduped by account id so it
     can't double-trade.
  2. **No loss-side exit existed.** `manageHeldExits` only had a trailing stop that arms
     after +1.5% gain and a momentum-death that fires only while in profit — a position
     that goes straight down triggered neither, leaving the entry stop as the *only* loss
     protection. Added a **hard max-loss backstop**: market-exit any long down ≥
     `TRADER_MAX_LOSS_PCT` (default **8%**), regardless of momentum/peak/min-hold (still
     debounced by the exit-reattempt guard).
  3. **Re-protect couldn't stop an already-underwater position** — the entry-based stop
     (entry×0.98) sits *above* market for a loser, which the broker rejects, so the loser
     stayed naked. The re-protect pass now clamps the stop to just below the current price
     so an underwater long still gets a working protective stop.
  All thresholds are env-overridable. Covered by new tests in
  `apps/lantern-garage/test/auto-trader-trailing.test.js` (a −10% loser is backstop-exited
  even inside min-hold; a −3% position is left for the broker stop).
