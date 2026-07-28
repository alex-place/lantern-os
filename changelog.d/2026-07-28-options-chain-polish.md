### Changed
- **Options chain reads like a chain, not a stack of cards.** Expiry sections now
  carry a rotating ▶/▼ caret so it's obvious they expand; dates render as
  "July 29" instead of `2026-07-28` (short `Jul 29` in the volatility chips and
  volume column heads); the sections form one continuous bordered list with denser
  rows, sticky column headers and row hover; and the page opens on the nearest
  expiry that actually **has quotes** rather than blindly the first — after hours
  the 0-DTE expiry returns empty IV/delta columns, so the page used to open on a
  wall of dashes that read as broken.
- **One wordmark across the trading pages.** Watch / Trade / Options all show
  **UnisonaTrader** instead of renaming itself per page; the in-page tabs already
  say which of the three you're on.
