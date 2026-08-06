### Added

- trader: portfolio-level cash reserve — `TRADER_MAX_GROSS_PCT` (default 80) caps total deployed capital; the account always keeps the remainder in cash. Per-position caps alone never bounded the sum. Exits are never blocked by it.
- backtest: 15m harness gained daily-timeframe knife gates for the mean-reversion entry (`meanrev-sma20`, `meanrev-knife`) — measured: the knife gate halves TLT's loss but costs QQQ's win; neither is a clean fix on 22 days of data.
