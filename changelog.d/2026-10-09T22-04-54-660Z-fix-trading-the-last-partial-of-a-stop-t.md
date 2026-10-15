### Fixed

- fix(trading): the last partial of a stop that fills in pieces keeps its entry basis — the engine S SMH stop of 2026-10-09 filled 12 / 9 / 9 and the third row was journaled with no entry and no P&L (the day's booked realized short by $51); the brain now remembers the basis it saw while the symbol was held and falls back to it when the book is empty and no newer entry was placed; the drift row names a registered stop's partial fill. Journal-only.
