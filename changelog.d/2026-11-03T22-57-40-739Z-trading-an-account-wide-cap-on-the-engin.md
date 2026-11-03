### Added

- trading: an account-wide cap on the engine's trades, off unless the config sets maxTradesPct. A buy that would take the whole book past that share of equity is refused and journaled; the cash reserve does not count, sells and stops are never refused, and with no readable broker snapshot a buy is refused. No live config changes here.
