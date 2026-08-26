### Fixed

- **A price-threshold exit that triggers outside regular hours now fills at the open, not
  in the dark.** SOXL, 2026-08-26: `trailing_stop` fired at 08:36 and filled at 113.52 on
  a real, sustained pre-market fall. The session opened at **115.54** and ran to **117.19**.
  Realised **−$2,647** where the same decision filled at the open would have been roughly
  **+$418**.
- Not bad luck — the median outcome. Measured over 59 days, 10 names, 580 symbol-days:
  after a pre-market drawdown of −1.5% or worse the open was **above** the pre-market low
  **79%** of the time (the −2.0/−1.5% band opened +1.77%, +2.33% an hour in). After-hours
  is **88%**. Every credible band in both windows reverts at the open.
- **The decision still stands and the position still leaves the book** — `#3378`'s reason
  for managing the extended session is untouched. Only the fill moves to 09:30. The
  decision is journaled as `exit_deferred` and survives a restart.
- **`max_loss` is excluded**: that is the disaster brake, not gain protection, and a
  position already at its loss cap should not wait. The broker's resting stop stays
  underneath throughout. `TRADER_EXT_DEFER_EXITS=0` reverts.

### Method note

The deepest drawdown band was **discarded as bad data**, not reported: every one of its
worst entries was a **zero-volume** Yahoo print (SPY −7.2% at 17:00 on no trades, GLD
appearing 34 times). Taken at face value it would have shown a +5.26% bounce and inflated
the case for this change.

### Known limit

59 days and one clean measurement — narrower than the two-window bar this repo normally
requires. Reliable extended-hours history barely exists (see above), so a holdout replay
of this rule is not currently possible. It accepts a real gap-down risk on the minority of
days that do not revert.
