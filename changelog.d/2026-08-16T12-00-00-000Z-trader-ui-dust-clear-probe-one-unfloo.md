### Added

- trader-ui: **Clear dust** — a sub-share remnant now gets one unfloored sell attempt, and IBKR's verdict is reported verbatim. The bridge floors every quantity, so `floor(0.8)=0` made dust exits unexpressible; that floor was inferred from a single 2026-07-28 rejection while the same ledger shows the account *holding* fractional size. `allowFractional` is reachable only from this endpoint: sells only, sub-1-share only, verified holding, admin only, quantity never caller-supplied. Either outcome is logged as a `dust_clear_probe` — the constraint becomes evidence instead of folklore
