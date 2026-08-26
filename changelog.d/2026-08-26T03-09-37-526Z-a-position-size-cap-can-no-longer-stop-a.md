### Fixed

- **A cap on position SIZE could stop a position being CLOSED.** Reported live while
  flattening both books: the app refused to sell SOXL — 1,517 shares at $115.67 =
  **$175,471** against a cap of 12% × $966,744 = **$116,009**. The position could be
  opened and then not shut. `orderGate` now takes the `side` its JSDoc has always
  documented (and that `ibkr-cpapi.js` has always passed, unread), and applies the
  per-position notional cap to **buys only**. Every other gate — the global halt file,
  `TRADER_LIVE`, the account-mode opt-in, `MAX_ORDER_QTY` — still applies to sells;
  the trader is longs-only, so this opens no naked-short path. `alpaca-adapter.js` now
  passes `side` too.

### Known, not fixed here — two reasons the trap could form

- **The guard's cap is blind to the multipliers the sizer applies.** `auto-trader`
  scales `maxPositionPct` by room tier × stress × symbol tilt, so SOXL sizes at
  12% × 1.5 = **18%**, and **27%** at VIX ≥ 20. `trading-guard` reads the raw 12%. The
  engine can legitimately build a position the guard will not transact.
- **The cap only binds when a price is present**, so a MARKET order skips it entirely
  — which is why the oversized entry was placed without complaint. `#3326` then
  converts an out-of-RTH flatten to a marketable LIMIT so it can execute, and *that*
  is what gives it the price that trips the cap. The cap was inert for the order that
  took the risk and binding on the order that would have shed it.

  Both are risk-policy calls for the operator, not silent fixes.
