### Added

- trading/overnight: **the overnight sleeve book** (`lib/overnight-trader.js` + `GET/POST
  /api/trading/overnight`) — the day-trader's measured best self, productized from the
  research arc's strongest results (oracle ledger `bandits-trader-*`,
  `downtrend-decomposition-*`): 4 trend+vol-gated long sleeves (SPY/IWM/GLD "notflat",
  QQQ "flat"), 2 **capitulation** longs (downtrend closing at a 20-day low → overnight
  gaps up, +18bp/night, t=3.5 over 30y), and a **bear-rally fade** via SH (SPY-only
  signal, t=−2.1). Backtested book: Sharpe 1.78, max DD −3.1% (23y, net of IBKR costs).
  Enters 15:45–15:59 ET Mon–Thu, exits at the next open — the auction prints the
  backtests measured. **Opt-in and dry by default** (`OVERNIGHT_TRADER=1` to tick,
  `OVERNIGHT_ARM=1` to place paper orders through the broker facade; live accounts stay
  behind trading-guard). Ledger `overnight-trades.jsonl`; ticked fail-soft from the
  autoscan loop.

### Changed

- trading/champion: **honest leverage accounting + gross modes** (`lib/sigma-trader.js`).
  The 23y walk-forward re-measured with real financing (Fed Funds + IBKR's 1.5% spread)
  showed the static-2× book beating SPY on both CAGR and Sharpe (17.6%/0.79 vs
  11.1%/0.66) — so the overlay is now selectable: `SIGMA_GROSS_MODE=brake|1x|2x`
  (default **brake**, the best-Sharpe variant, unchanged behavior). Every plan/ledger row
  now carries `gross_mode` and a `financing` block — borrow APR (live Fed Funds via
  FRED, cached daily, `SIGMA_BENCHMARK_RATE` override) and est. daily cost when gross>1,
  cash yield (BM−0.5%) when gross<1 — so the paper track record no longer overstates a
  levered book by its un-modeled borrow cost. Still paper-only, SIGMA_ARM-gated, per
  ADR-0028.
