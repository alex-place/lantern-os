### Fixed

- trading: fill attribution — an untagged fill only goes to a sleeve whose claim predates it, the fill ledger never books a fill older than the position it matches, and a stop that fills below entry is never labeled a breakeven round trip (2026-09-25: R's TLT stop fill booked twice; 2026-09-03: a -2.87% SOXS stop-out labeled be_ratchet)
