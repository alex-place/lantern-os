### Fixed

- explore.html demo portfolio and watchlist no longer show two different prices for the same symbol. The demo book's positionsLive() now accepts a seed of the watchlist's own quotes (getWatchlistPrices) and lets them WIN for shared symbols, instead of an independent yahoo fetch that could miss a ticker and fall back to a ~5%-stale baked mark. A symbol in both surfaces renders one price (#2983).
