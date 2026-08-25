### Fixed

- **Six trader test fixtures could fail because a real stock moved.** They hold a
  position in `LNG` — a real ticker (Cheniere Energy) — and the engine's
  market-data-driven exits fetch live bars for whatever symbol it is holding. With
  those exits at their defaults, `momentum_died (MACD hist<0, <EMA9, RSI 40)` closed
  the position out from under the behaviour under test. Same commit, same machine:
  **green at 14:49 ET, red at 15:58 ET** — `be-ratchet` lost 6 of 10 tests and
  `eod-flat` 4 of 7, purely on the afternoon's tape.
- All six now pin the five exit-authority switches to their **armed production**
  values (`#3437`/`#3438` — momentum/zone/take-profit/min-pwin/decarry all off), which
  makes them deterministic *and* more faithful to the engine that actually runs.
  `be-ratchet` 10/10, `eod-flat` 7/7, `ibs-exit-gate` 9/9, `limit-shadow` 5/5,
  `stack-guard-drift` 5/5, `step-floor` 5/5, `exit-authority` 6/6 (already guarded).
