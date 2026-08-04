### Changed

- trader: fast exit loop — price-only exit checks every 10s between scans (ladder/trailing/max-loss react in seconds; no extra Yahoo calls); TRADER_FAST_EXITS=0 kills
