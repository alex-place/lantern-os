### Fixed

- trader: an unexplained flat reading is no longer an entry opportunity. The `already long` guard trusted a single position snapshot, so when the broker feed dropped SOXS for two scans on 2026-08-13 the engine opened a full-size tier-A+ position on top of the 1,490 shares it already held — 3,057.8 total, twice the intended maximum, behind a stop sized for part of it. A confirmed holding whose disappearance no *filled* exit explains is now treated as a feed dropout; only a real fill clears the veto, since a reconstructed exit is inferred from the same absence
