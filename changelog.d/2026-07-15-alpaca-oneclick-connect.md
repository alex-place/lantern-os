### Added

- broker: one-click Alpaca connect (ADR-0027) — OAuth2 authorize→approve→connected, no keys to generate or paste. Paper account by default; per-user token stored AES-256-GCM encrypted, never returned to the client. New `/api/broker/alpaca/{connect,callback,status,disconnect}`, `alpaca-credentials.js` store, and `alpaca-adapter.js` implementing the same getAccount/getPositions/placeOrder surface as the IBKR path.
- broker: manual orders + positions now route to a connected Alpaca account when no IBKR account is linked (IBKR → Alpaca → legacy fallback); every order still passes trading-guard (dry unless TRADER_LIVE=1; live Alpaca additionally needs TRADER_ALLOW_LIVE_ACCOUNT=1).
- ui: "⚡ Connect Alpaca" on orchestration#broker (above the IBKR wizard), a broker-connect panel on work.html, and a "Here to trade?" on-ramp on the sign-in page. All degrade honestly to "setup pending" until the server has ALPACA_OAUTH_CLIENT_ID/_SECRET.

### Changed

- docs: ADR-0027 Accepted (Alex approved) — tiered broker connect: Alpaca one-click now, IBKR self-service as the power tier, IBKR partner OAuth pursued in parallel behind one adapter seam.

### Changed (follow-up)

- broker: the autopilot is now broker-agnostic (broker-facade.js) — the autonomous scan loop drives a connected Alpaca account too, not just IBKR. Per user the facade resolves to their actual broker (IBKR preferred for execution quality); every order still passes the per-account hard guard (dry unless TRADER_LIVE=1). alpaca-adapter gains standalone stop orders (GTC SELL STP) + open-orders/day-P&L so the re-protect and trailing-exit logic works identically across brokers.

### Fixed (paper testing)

- trader: the PAPER badge is now real. A new local paper-trading simulator (stock-paper-ledger.js) gives every unconnected user a virtual $100k account that FILLS orders at the live feed price and shows the resulting positions — replacing the dry-run dead end where a paper order silently "failed". Broker precedence is now IBKR → Alpaca → local paper sim.
- trader: removed the half-baked native browser popups. Order placement, Flatten, and Close-all use an inline two-step confirm (the button arms — "Confirm BUY 5 NVDA →" — then a second click sends), and every result is a styled toast ("✓ BUY 5 NVDA @ $211.80 (paper) — filled") instead of a native alert(). A dry-run from a connected-but-unarmed broker now reads as "not armed", not "Order failed".
