### Added

- explore.html is now a personalized, Robinhood-style investing **dashboard**: a portfolio header (total value + day/range change), an equity chart with a **1D/1W/1M/3M/YTD/1Y/ALL** range selector and a **Line ↔ Candlestick** toggle, holdings, a live watchlist, and market news. New `GET /api/trading/portfolio/history?range=` (Alpaca-backed, via `lib/alpaca-adapter`) powers the equity curve.
- Champion **demo showroom** (`lib/champion-demo`): logged-out / non-trade-entitled visitors see a read-only simulated account modeled on the measured "$2k + $20/mo" champion strategy ($91.8k, 8-asset momentum mix) instead of an empty "connect a broker" shell — on both the Explore dashboard and the stock-trader terminal (badged **DEMO**, all trade actions hidden). Served only on the explicit `?demo=champion` public read; real broker data stays trade-gated.

### Fixed

- Dashboard chart: the empty-state message (`.chart-empty`) set `display:flex`, which overrode the `[hidden]` attribute, so "Your equity curve appears here…" stayed visible under a drawn chart and doubled the chart height. `hidden` now wins.
