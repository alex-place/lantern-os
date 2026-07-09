fix(trader): clean "Chart data unavailable" state for zero-bar symbols in guest mode

A charted symbol with a live price but no OHLC bars (feed gap, or a default-
watchlist symbol the bars feed hasn't populated — visible to guests, who get the
server default watchlist) drew a half-empty/broken chart because `_renderLadder()`
only bailed to a placeholder when the *price* was missing. It now renders a clean
centered "Chart data unavailable" state and clears the canvas, gated on a new
`barsLoadedOnce` flag so it never flashes over charts still loading. Verified in a
logged-out preview: normal charts unchanged, a zero-bar symbol shows the clean
state. Improves Observe (honest empty state over broken output).
