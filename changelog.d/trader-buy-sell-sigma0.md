### Σ₀-grounded BUY/SELL emphasis on the stock-trader cards

- Each ticker card on `/stock-trader.html` now emphasizes only the **grounded** side of the trade: BUY lights up on a bullish signal, SELL on a bearish signal, and **both** mute when the card is flat/neutral or below the conviction floor. (#1578)
- The gate reuses the card's existing `dir` + `conf` (the same pair that drives the `conf-badge`) and the canonical `MIN_CONVICTION = 65` floor from `lib/kalshi-suggest.js` — no duplicated signal logic. A side is emphasized only when `conf ≥ 65 AND dir matches`.
- Every button carries a grounding tooltip in `[signal, evidence, confidence]` form (e.g. "BULLISH · 72% conviction ≥ 65% floor" / "no grounded signal — 50% conviction < 65% floor"), so there is no emphasis without a stated, truthful reason (External Reality Rule). Emphasis updates live in `updateCardMeta` as signals change.
