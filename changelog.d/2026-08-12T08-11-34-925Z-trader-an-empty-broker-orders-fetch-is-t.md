### Changed

- trader: an empty broker orders fetch is treated as UNKNOWN, not 'every position is naked' — defers re-protection one scan instead of stacking duplicate GTC stops (the 2026-07-27 488-stop oversell mechanism)
