### Added

- trading/alpaca: **bring-your-own-keys Alpaca connect.** A user can now paste their own
  Alpaca **paper** API Key ID + Secret in Settings → Connections → Alpaca and be
  connected immediately — no OAuth (the Alpaca OAuth client is still pending activation).
  Keys are verified against Alpaca `/v2/account` before saving and stored AES-256-GCM
  encrypted per user (`lib/alpaca-credentials.js` `saveKeys`), exactly like the OAuth
  token and the BYOK AI-provider keys. New endpoint `POST /api/broker/alpaca/connect-keys`
  (paper-only; live is a later gated step). `alpaca-adapter._authFor` precedence is now
  **user OAuth → user keys → shared server keys**.

### Fixed

- trading/orders: **manual buy/sell now works on Alpaca.** `POST /api/trading/orders/place`
  used to try IBKR first by default and break its attempt loop on the *first non-null*
  result, so an Alpaca user's order could hit an IBKR error (or the "No broker connected"
  dead-end) and never reach Alpaca. It now tries the user's **intended** broker first
  (Alpaca-first unless the user explicitly prefers IBKR) and surfaces that broker's own
  answer, only falling through when a broker is genuinely not connected — so an order is
  never silently re-routed to a broker the user didn't choose. Also removed the legacy
  `traderAgent`-required 503 gate (placement goes straight to the broker adapter) and made
  the order-history tab read Alpaca whenever Alpaca is the active broker.

- trading/search: the symbol-search popup now has a real Alpaca universe. `alpaca-adapter`
  gained a cached `listAssets()` (`/v2/assets`, ~13k tradable US equities/ETFs); when
  Alpaca is the connected broker (and IBKR isn't), `/api/trading/symbols/search` fuzzy-
  matches against it instead of degrading to a single exact-ticker Yahoo probe.

Charts (Yahoo), news (Yahoo RSS) and watchlist add/remove are broker-independent and
already work on Alpaca. Verified end-to-end on the dev server: paste-keys connect
(account PA3KZEWVVZTP), bad keys rejected, a paper BUY accepted by Alpaca, a SELL kept on
Alpaca (surfaced Alpaca's own error, no IBKR leak), and 13,288-asset fuzzy search.
