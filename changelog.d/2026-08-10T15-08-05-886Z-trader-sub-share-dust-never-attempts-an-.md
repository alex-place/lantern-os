### Changed

- trader: sub-share dust never attempts an exit (qty<1 unfillable by construction) — ends the 3-error-orders-per-restart SOXS spray in both the exit manager and the bearish signal-exit branch
