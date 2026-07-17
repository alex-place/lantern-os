### Added
- **Broker choice now persists in a cookie (ADR-0027).** Picking Alpaca/IBKR in the trader ☰ or on orchestration#broker sets a 1-year `broker_pref` cookie that `preferredBroker()` honors above the per-user store and the `BROKER_PREFER` env default — so the choice survives reloads and guest-id drift instead of snapping back to Alpaca/auto. On single-user (auth-off) boxes the choice also mirrors into the `local-owner` store so the background auto-trader follows the same broker. Request-bound routes (positions, order placement) read the cookie too.

### Changed
- **"Close all positions" now always asks for confirmation.** It was a subtle inline two-step that Rapid mode skipped entirely — a single stray click could flatten the whole book. It now shows a hard blocking confirm (count + total market value) that Rapid mode cannot bypass.
