### Added — grounded EDGE badge on the Kalshi terminal (the moat surface)

Each decisive-deck card now shows what Verso (a data terminal) can't: not "what moved" but
**what's mispriced**. `lib/kalshi-edge.js` combines our CACHED web-grounded P(YES)
(`kalshi-grounding.peek` — no LLM call on the render path), fee-adjusted EV
(`kalshi-fees.netEvCents`), and our forward calibration (`kalshi-calibration` Brier) into one
badge per market:

> `EDGE · BUY YES +5.3¢ after fees · P(YES) 62% vs mkt 55% · Brier 0.18 · n=42`

Green for +EV, red for −EV. Ungrounded markets claim no edge (`{grounded:false}` → no badge),
per the External-Reality Rule. Wired into `/api/trading/kalshi/decisive-deck` via
`attachEdges()`. Unit-tested (5 cases); render verified in preview.
