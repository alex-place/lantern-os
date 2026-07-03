- **Trader broker path moved to IBKR; gated live order placement (dry by default).**
  `trader-agent` positions/account/orders now come from the IBKR Client Portal
  gateway (`lib/ibkr-cpapi.js`) instead of Python/Alpaca — an honest "gateway not
  connected" replaces the old "broker not configured", and market-status no longer
  hides VIX/regime behind broker creds. Order placement is added to the IBKR client
  and fronted by a new `lib/trading-guard.js`: **DRY by default** — no real order is
  sent unless `TRADER_LIVE=1`, the shared `LIVE-KILL-SWITCH` is absent, size/notional
  caps pass, and (on a live account) `TRADER_ALLOW_LIVE_ACCOUNT=1`. See
  `docs/adr/0020-ibkr-live-order-placement.md` (Proposed). Phase 2 of the
  Python-trader removal.
