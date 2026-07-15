### Added

- broker: one-click Alpaca connect (ADR-0027) — OAuth2 authorize→approve→connected, no keys to generate or paste. Paper account by default; per-user token stored AES-256-GCM encrypted, never returned to the client. New `/api/broker/alpaca/{connect,callback,status,disconnect}`, `alpaca-credentials.js` store, and `alpaca-adapter.js` implementing the same getAccount/getPositions/placeOrder surface as the IBKR path.
- broker: manual orders + positions now route to a connected Alpaca account when no IBKR account is linked (IBKR → Alpaca → legacy fallback); every order still passes trading-guard (dry unless TRADER_LIVE=1; live Alpaca additionally needs TRADER_ALLOW_LIVE_ACCOUNT=1).
- ui: "⚡ Connect Alpaca" on orchestration#broker (above the IBKR wizard), a broker-connect panel on work.html, and a "Here to trade?" on-ramp on the sign-in page. All degrade honestly to "setup pending" until the server has ALPACA_OAUTH_CLIENT_ID/_SECRET.

### Changed

- docs: ADR-0027 Accepted (Alex approved) — tiered broker connect: Alpaca one-click now, IBKR self-service as the power tier, IBKR partner OAuth pursued in parallel behind one adapter seam.
