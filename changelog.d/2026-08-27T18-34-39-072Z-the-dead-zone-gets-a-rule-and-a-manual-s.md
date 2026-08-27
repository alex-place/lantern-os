### Added

- **`TRADER_MAX_HOLD_SESSIONS`** — flatten a position at the close of its Nth session.
  **Not a new idea:** the lab config every armed number came from (`armed_baseline`
  MONDAY, the 2,866% 26-year holdout) includes `timeoutS: 5`, and the engine simply
  never implemented it. The gap produced a live victim: SPXS on race held **3 sessions
  with zero exit attempts** — perma-BULLISH reads meant the bounce exit was never even
  evaluated, peak +0.64% never armed the +1% floor, −1.9% never hit the −3% stop. The
  dead zone, on tape. Default **off**; the validated value is **5**. Pinned symbols
  exempt; a position with no recorded entry time is held, never liquidated blind.

### Fixed

- **A manual SELL cancels the symbol's resting stops first.** The broker reserves held
  shares against a working protective stop, so a manual flatten of a stopped position
  was refused — Alpaca: *"insufficient qty available (requested: 492, available: 0)"*
  (today's SPXS); IBKR: oversell protection cancels one of the two sells (the 08-10 QQQ
  incident). The engine's exit path has done cancel-first-and-settle since `#3407`; the
  manual route never did, and it trapped the operator **twice** (08-20, 08-27). It now
  reuses the engine's own `cancelRestingStops` through the broker facade — settle wait
  included — and the response carries a `stops_note`. Fail-soft: a cancel error degrades
  to today's behaviour, never a new failure.
