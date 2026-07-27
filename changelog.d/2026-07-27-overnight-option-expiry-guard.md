### Fixed
- **The options exec tier now refuses a symbol with no next-session expiry.** The trade
  being measured is close → next open, but `listNextExpiryCalls` returns the nearest
  *available* expiry — measured 2026-07-27: SPY/QQQ/IWM list next-day, **GLD +1 day, SH
  +24 days** (monthlies only). Without the guard the SH fade sleeve would have bought a
  multi-week option and sold it at the next open — a different instrument entirely
  (weeks of theta/vega held for one night) — silently corrupting that sleeve's measured
  expectancy. Those sleeves are now skipped with the real reason in the ledger.
