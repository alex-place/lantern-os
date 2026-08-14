### Fixed

- trader-ui: pre-market moves now count as today's P&L. The Sunday-phantom guard gated carried positions to $0 until 09:30, freezing the panel against a book IBKR marks all night; the phantom only ever occurs on non-trading days, so the gate is now weekday-from-04:00-ET (quote chart rolled, prevClose = yesterday's close, pre-market prints live). Weekends and the 00:00–04:00 dead zone still read $0; the basis string says "(pre-market marks)" before the open
