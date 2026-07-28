### Changed
- **Trader watchlist rows line up.** Each row is now a two-column grid (symbol/change
  left, price/signal right) instead of two `space-between` flex rows, so prices,
  changes and signals form real columns rather than drifting with each value's width.
  Prices also use one decimal convention — the old formatter mixed 4dp under $100 with
  locale formatting above it, putting `$171` beside `$84.2250` and `$675.805`.
- **Wider default sidebar** (210 → 264px desktop, 170 → 210px tablet; drag range
  180–460px) — the two-line rows were cramped at the old width.
- **Removed the "AI tradelist — the autopilot trades only these" banner** from the top
  of the sidebar; the sidebar's own label already says it.
