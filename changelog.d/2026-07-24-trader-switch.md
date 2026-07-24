### Added

- trading: **active-trader switch** (Phase 2 of the Alpaca-first work) — one connected
  account, one active strategy. In Settings → Connections a new **Active trader** control
  lets a user pick **📈 Stock trader** (signal entries + their manual buy/sell — the
  default) or **🏆 Champion** (the automated diversified ETF-allocation book,
  `lib/sigma-trader.js`, run on their OWN account). The stock-trader dashboard pill now
  shows the active trader and links to the switch (replacing the broker pill, since the
  app is Alpaca-only now).
  - New per-user store `lib/trader-mode.js` + `GET/POST /api/trading/mode` (+ a
    `trader_mode` cookie), mirroring the broker-preference store.
  - `lib/sigma-trader.js` `plan()` / `rebalanceNow()` now accept an optional `userId` so
    the Champion book can run on the user's own connected account (paper-only; DRY unless
    `SIGMA_ARM=1`, same governance as the standalone Sigma book). `GET/POST
    /api/trading/champion?mine=1` targets the current user's account.
  - The autopilot loop (`routes/trading.js` `_autoscanTick`) honors the mode: a
    'champion' user's day-trader is **paused** and the Champion rebalance runs on their
    account instead (throttled to ≤ once/hour). 'stock' users are unchanged.
  - Covered by `apps/lantern-garage/test/trader-mode.test.js`; verified on the dev server
    (switch flips in place, pill reflects the mode, Champion plan computed real target
    weights on the user's $96k paper account).
