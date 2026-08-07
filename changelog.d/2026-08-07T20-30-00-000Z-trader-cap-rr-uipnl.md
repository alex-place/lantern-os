### Fixed

- trader: the concurrency cap now counts entries opened during the same scan. `heldPos` is a start-of-scan snapshot, so several entries in one cycle each saw the same pre-scan count — on 2026-08-07 that left 3 positions open against `maxConcurrent=2`.
- trader: `TRADER_MIN_ENTRY_RR` (default 1) skips entries whose **floored** stop leaves reward:risk below the threshold. The stop floor and the 3:1 derivation fight each other; when the floor wins, RR can collapse — SOXL took a 3.00% stop against a 1.60% target (0.53:1) and closed −$217.
- trader UI: Day P&L is `realized + unrealized` instead of each position's move since *yesterday's close* plus a `realized_today` that IBKR always reports as 0.00. The old formula credited positions with rallies they were never in and hid every closed loss — it showed **+$1,383.96** while the broker read **−$337.60**.
