### Fixed

- **A cap on position SIZE could stop a position being CLOSED.** Reported live while
  flattening both books: the app refused to sell SOXL — 1,517 shares at $115.67 =
  **$175,471** against a cap of 12% × $966,744 = **$116,009**. `orderGate` now takes the
  `side` its JSDoc has always documented (and that `ibkr-cpapi.js` has always passed,
  unread), and applies the per-position notional cap to **buys only**. Every other gate
  still applies to sells — the halt file, `TRADER_LIVE`, the account-mode opt-in,
  `MAX_ORDER_QTY`. `alpaca-adapter.js` now passes `side` too.
- **The per-position cap now binds on MARKET orders — where the risk actually goes in.**
  It computed notional from the LIMIT price, so a market order priced at nothing had a
  notional of nothing and skipped the cap entirely. Market buys are the engine's normal
  entry path, so the 12% cap was **unenforced on every ordinary entry** — SOXL sat at
  18% of equity and nothing objected — while binding on the marketable-limit conversion
  `#3326` applies to an out-of-RTH flatten. A market order is now priced against the
  caller's `refPrice` (the same quote the entry was sized from), wired through
  `auto-trader` → `trading-api-bridge` → `ibkr-cpapi`. An unpriced buy stays allowed — a
  documented limit rather than an oversight: `orderGate` sits under a general-purpose
  `placeOrder()`, and refusing every priceless buy broke the IBKR warning handshake
  immediately. Every engine that sizes against equity (`auto-trader`,
  `overnight-trader`) now passes `refPrice`, so the paths that can build an oversized
  position are covered.
- **The guard now reads the same sizing policy the sizer does.** `auto-trader` sizes
  against `maxPositionPct × roomTier × stress × symbolTilt`; the guard read the bare
  `TRADER_MAX_POSITION_PCT`. While the cap was inert on market orders that mismatch was
  invisible — the moment it starts binding it would have refused **every tilt-1.5 entry**
  (SOXL/SMH/QQQ size to 18% against a 12% gate), silently deleting the three
  highest-weighted names. The ceiling is now derived from the same environment the sizer
  reads, so the guard stays an independent check instead of contradicting the configured
  policy. Room tier is excluded (it is off, and is per-signal rather than per-symbol).

  **Effective ceilings at the armed config** (12% base, stress 1.5 as constant headroom):
  SOXL/SMH/QQQ 27%, XLK 18%, SPY 14.9%, DIA 12.8%, GLD/TLT 9%.
