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
- **`TRADER_MAX_POSITION_PCT` is now a HARD ceiling — the symbol tilt cannot raise it**
  (operator's call). Until now `auto-trader` multiplied the per-position cap by room
  tier × stress × symbol tilt, so SOXL/SMH/QQQ sized to **18%** of equity and **27%** at
  VIX ≥ 20, while `trading-guard` read the bare 12% — which is why the guard refused to
  transact positions the engine had legitimately built. Guard and sizer now agree on one
  number: the multipliers still scale the *risk target*, but the notional ceiling is
  clamped at `TRADER_MAX_POSITION_PCT`. Down-weights are untouched — SPY 0.83 still sizes
  to 9.96%, GLD/TLT 0.5 to 6%.

  **Measured before arming** (`experiments/hard_cap_lab.js`, four surfaces, live env) —
  return/DD **h1 −15%, d-fit −40%, h2 −22%, d-hold −44%**. On the 26-year holdout that is
  **2,866% → 1,202%** of return against a drawdown of **22.1% → 16.5%**: 58% of the return
  given up to remove 25% of the drawdown. Win rate is unchanged at 64% — sizing does not
  change which trades are taken, only how big. `TRADER_MAX_POSITION_PCT` is the single
  knob that reverses it.
- The cap is measured against `refPrice` in preference to the order's own limit price.
  The two differ by design on the extended-hours path: `#3326` prices an out-of-RTH entry
  0.2% through the spread so it can fill, and capping on that uplift would refuse an
  order the sizer built to fit.
