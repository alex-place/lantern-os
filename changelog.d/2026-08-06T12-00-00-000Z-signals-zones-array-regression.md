### Fixed

- signals: the scan signal now carries the zone LIST, not just the support/resistance scalars. `auto-trader` reads `s.zones` as an array, so it always saw `[]` — silently disabling the support-entry gate (8 of 12 tradelist symbols could never enter), the zone-ladder exit (zero `zone_r1`/`zone_r2` exits in the entire live ledger), room tiering and `tgtMinR`.
