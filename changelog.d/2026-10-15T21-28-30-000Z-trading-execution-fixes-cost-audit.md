### Fixed
- trading: a stop fill whose broker record carries no execution time is no longer stamped with the time the stop was PLACED (IBKR `orderTime` fallback): SMH 2026-10-15 (placed 10-14, filled at the 10-15 open) and SLV 10-14 were booked to the wrong day and missing from both days' P&L. The placement time now feeds only the fill ledger's age guards.
- trading: stop raises (break-even ratchet, stepped floor, first lock) wait for the regular session — a raise read off a thin pre-market mark parked GDX's stop over the 10-15 opening print. `TRADER_RATCHET_EXTENDED=1` restores the old behaviour.

### Added
- trading: `TRADER_GAP_STOP_TO_OPEN=1` (default off) — in the pre-open window (09:20-09:28 ET) a protective stop the pre-market already trades through is replaced by a market-on-open sell, so the position sells IN the opening auction instead of a few seconds after it under the official open (five stable stops since 09-01 filled $1.0k under their opens). A refused auction order puts the stop back at its original level; no stop is stacked on a working auction order. Both broker paths accept `timeInForce: 'opg'`.
