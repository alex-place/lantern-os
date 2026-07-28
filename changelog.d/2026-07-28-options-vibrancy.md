### Changed
- **Options page vibrancy pass (TradingView-benchmarked).** Chain: saturated ITM
  bands (13%), bright green/red volume numerals with gradient bars, a blue-bordered
  spot pill (`SPY 746.00 USD`) on the divider, visible IV column. Volume tab is a
  real **heatmap** — each cell's background scales with its share of the table max
  (sqrt-scaled, white text on hot cells), ATM strikes marked in blue. Volatility:
  thicker full-opacity smile with a gradient fill, and it now defaults to the
  nearest expiry that actually carries IV (the 0-DTE default rendered "Not enough
  IV data" after hours).
