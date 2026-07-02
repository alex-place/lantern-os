feat(chat): trader is a Tool in the one chat loop — market status, quotes, positions (#1434, #1560)

Keeps the stock trader as a Tool inside the single chat loop (ADR-0008/ADR-0013)
instead of a disconnected surface, so dream-chat can reason over live markets
with evidence (the "personal financial reasoning cockpit", #1434) — and records
the scope decision #1560 asks for: trading = keep-as-Tool, not extract/delete.

Three tools added to the canonical registry (`lib/tool-runner.js`), each calling
the server's own loopback `/api/trading/*` endpoint so they reuse the trader's
live keyless data path (no second data source):

- `trader_market_status` (guest-safe) — VIX + regime, SPY 1d/5d trend, session open.
- `trader_quote` (guest-safe) — price, 1M/3M/YTD/1Y returns, volume, SMA20/50,
  technical rating for any ticker.
- `trader_positions` (operator-only) — the operator's paper positions + account;
  reports "broker not connected" honestly rather than inventing holdings.

Verified end-to-end through `runTool`: market-status returned live VIX 16.15/CALM;
`trader_quote NVDA` returned $194.83 / "below the 50-day"; `trader_positions`
returned the honest not-connected message; and a guest call to `trader_positions`
was denied (`operator_required`). Σ₀: every tool cites live evidence and refuses
to answer from memory when the feed is unavailable.
