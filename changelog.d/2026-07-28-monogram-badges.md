### Changed
- **Watchlist/tradelist ticker badges are now vector monograms** instead of fetched
  brand logos. The ETF universe shares a handful of issuer marks (SPDR/Direxion
  squares shrunk inside a circle at poor resolution), so rows read samey and
  blurry. Each symbol now gets a deterministic gradient badge (hue hashed from the
  ticker — stable across sessions and pages) with the ticker monogram in white:
  crisp at any DPI, every row visually distinct, and zero logo network fetches.
  Applies to the Trader and Watch sidebars.
