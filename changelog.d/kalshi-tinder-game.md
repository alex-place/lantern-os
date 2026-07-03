feat(kalshi): playable paper tinder-game + hardened live-order path

The Kalshi terminal now works as a full "Tinder for prediction markets" PAPER game:
- A virtual bankroll (`getWallet`, derived from the append-only ledger) that spends
  down as you buy — the cash gate refuses a buy you can't afford (buy until no cash).
- The deck composes buy candidates (markets you already hold are hidden) plus your
  open positions as SELL (TAKE) / HOLD (PASS) cards, so buy → hold → sell/stop lives
  in one swipe deck. A paper-cash HUD shows the bankroll + open count + realized P&L.
- AUTO stop-loss auto-closes a losing paper position at ≤ -25%; take-profit stays
  manual (sell for profit or hold).

Safety / hardening:
- The deck-prefetch runaway is fixed (an unconditional cooldown + futile-fetch
  backoff cut deck polling ~60/min → ~15/min, browser-measured).
- The live-order path is hardened: `source` is validated against the ticker (a
  mislabeled order can't borrow the weather-edge live allowance) and every live fill
  requires an explicit `confirmLive:true` — defense-in-depth on top of the kill
  switch. Everything stays paper/dry-run by default.

Tests: `test/kalshi-paper-game.test.js` (7 checks — wallet / buy / sell / hide-held /
auto-stop) and `test/kalshi-order-hardening.test.js` (3 checks). Improves the Act
stage (honest, safe tool execution).
