### Fixed

- trader: an ARMED trader now preempts a DISARMED (exit-only) holder of the same broker account. On 2026-08-05 the disarmed dev server held IBKR DUR193395 from the open and the armed trader stood down all morning — zero entries, no error.

### Changed

- trader: resistance zones nearer than 0.5R are treated as noise, not targets — they no longer arm the exit ladder or demote an entry to B-tier. OOS-gated on 5 symbols: better in both the fit and the holdout window.
