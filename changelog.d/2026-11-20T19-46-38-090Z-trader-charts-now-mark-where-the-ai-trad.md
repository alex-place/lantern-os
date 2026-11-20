### Added

- Trader charts now mark where the AI trader got in and out: an entry mark at the fill price, an exit mark coloured by win or loss, a card with the exact New York time, price, quantity, P&L and exit reason on hover or tap, and the entry and stop lines of an open position. Read-only: a new GET /api/trading/chart-trades maps the journal's rows to trades (double-logged exits collapse to one, unfilled statuses and shadow rows are never drawn); nothing in the trader's decisions, config or journal writing changed.
