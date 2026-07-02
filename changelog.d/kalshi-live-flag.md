### Added
- **Admin feature flag `kalshi_live_trading`** — a Patreon/admin-gated master switch for
  real-money Kalshi orders, surfaced on `/admin-flags.html`. Registered as a canonical
  "known" flag so it always appears (default **OFF**), marked `danger` with a real-money
  warning and confirm-on-enable, and non-deletable. It is an **additional AND-gate** in
  `kalshi-api.tradingEnabled()`: an off/absent flag can only keep the exchange path in
  dry-run, never arm it. Live orders still also require `KALSHI_TRADING_ENABLED=1`, the
  kill-switch file absent, and valid credentials. The connection snapshot now reports
  `envTradingEnabled` + `liveTradingFlag`, and a flag-off order records the explicit
  `live_flag_off` blocker.
