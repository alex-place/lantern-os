fix(trading): stop the market-status tile hanging when broker unconfigured (#1231)

#1860 gave `getPositions`/`getOrders` a `_brokerConfigured()` short-circuit, but
`getMarketStatus` was missed — so the VIX/regime tile still spawned Python,
which fails at `agents.py` import without Alpaca creds only after the full 7s
`fastTimeout`. `getMarketStatus` now short-circuits via the same helper.

Also bounds the `/api/trading/positions` route with a 2.5s client deadline: if
`getPositions()` is still cold (configured box, first poll), the route returns a
fast "warming" payload while the call keeps warming the 60s cache, so the next
poll serves live data instead of the page blocking on the cold spawn.

Measured on an unconfigured box: market-status 7345ms → 6ms; the trading page
renders with no spinners.
