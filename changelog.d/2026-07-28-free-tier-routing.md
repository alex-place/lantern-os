### Changed
- **Free users are routed to Watch instead of walled into the trader.** Clicking the
  nav's "Trader" as a guest/Free user landed on a dead terminal behind a Pro modal —
  a paywall before seeing anything work. They now land on `/watch.html?from=trader`
  with a one-time banner explaining that charts/watchlist/news/signals are free and
  what $20 Pro adds. `?stay=1` still opens the terminal preview deliberately.
- **Options analysis is free; only placing an order is Pro.** The chain, IV smile,
  volume view and advisory strategy proposals are read-only market data (same deal as
  the Watch page) and are now public reads — a logged-out visitor saw "Chain
  unavailable — no data source" on a page we link them to. `POST
  /api/trading/options/order` stays gated, and the manual ticket is replaced with an
  honest upgrade line for Free users rather than a button that fails.
