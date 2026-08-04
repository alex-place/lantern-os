### Changed

- trader: protective stops are ATR-based (the signal's own trade-plan stop, clamped 1-6%) instead of a flat 2%; per-trade risk drives the 1R take-profit; TRADER_ATR_STOPS=0 reverts
