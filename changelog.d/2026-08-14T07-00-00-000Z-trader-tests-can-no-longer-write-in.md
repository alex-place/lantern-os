### Fixed

- trader: tests can no longer write invented trades into the live convergence memory. Once the autopilot began emitting a record per entry/exit (#3286), every test that drove `runAutoTrade` wrote its fixtures to the real store — one run put 51 fake trades ("GLD long 19 @ 100.00", "NVDA @ 180.00") into production, indistinguishable downstream from real ones. `CONVERGENCE_RECORDS_FILE` now redirects the store, and a redirected trade ledger with a non-redirected store is treated as a test rig and emits nothing
