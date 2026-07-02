fix(trader): keyless market-status/validate + broker guards kill the 7s subprocess hang (#1860)

The stock-trader header (VIX/Market) and "+ Add symbol" search were dead: they
routed through a per-request Python→Alpaca subprocess that reliably hit the 7s
timeout (`get_market_status`, `validate_symbol`) or the ~45s `list_assets`
spawn, and `get_positions`/`get_orders` paid the same cold-spawn cost only to
fail when no broker creds are configured.

- `market-data-yahoo.js` gains keyless `getMarketStatus()` (VIX + regime + SPY
  trend + session-open from Yahoo) and `validateSymbol()` (live quote probe).
- `trader-agent.js` routes `getMarketStatus`/`validateSymbol` through Yahoo, and
  short-circuits `getPositions`/`getOrders`/`getAllAssets` to an honest empty
  result when no Alpaca creds are set — instead of a doomed multi-second spawn.
- The symbols/search route falls back to a keyless exact-ticker validation when
  the broker asset universe is unavailable, so "+ Add symbol" works for real
  tickers.

Verified over HTTP with no broker creds: market-status 0.59s (VIX 17.0/CALM,
was 7s timeout), positions 4ms honest-empty (was 7s), symbol-info 0.16s valid
(was 7s), search?q=NVDA returns NVDA in 0.10s (was 0 results / 12–20s timeout).
Broker equity/P&L correctly stay absent without creds — but without the hang.
