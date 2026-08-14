### Fixed

- trader: the session row describes THIS book — `heldPos` is every position in the account, so without the `_ourSyms` ownership filter the champion book's XMMO/SPMO landed in `carried_out`, inflated `open_risk` and were marked into the day-trader's Day P&L. Same leak as #3277, caught before the first row was written
