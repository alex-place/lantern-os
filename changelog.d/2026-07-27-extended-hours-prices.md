### Fixed
- **Quoted prices now reflect pre-market and after-hours.** The charts already drew
  extended-hours bars (`includePrePost=true`), but the price beside them came from
  `meta.regularMarketPrice`, which freezes at the 16:00 close — measured 2026-07-27 at
  17:46 ET: SPY's last bar was 739.47 while the displayed price still said 739.09. Two
  causes: the quote path fetched a **daily** bar (where `includePrePost` is a no-op) and
  Yahoo leaves `post/preMarketPrice` null. It now fetches a 5-minute intraday series and
  derives the latest print from it, tagging each quote with its `session`
  (`regular` | `pre` | `post` | `extended`) so the UI can label an extended-hours price
  honestly instead of passing it off as the close.
