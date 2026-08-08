### Fixed

- trader: dust and unclosable positions no longer consume a concurrency slot. The cap shipped counting every `qty > 0` row, so the SOXS remnant (0.8 shares, $35, unclosable) plus one real position saturated `maxConcurrent=2` — every entry would have been refused. `TRADER_DUST_PCT` (default 0.1% of equity) sets the floor.
