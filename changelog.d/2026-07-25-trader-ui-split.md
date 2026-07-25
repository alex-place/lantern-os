### Added

- trading/ui: **the trader is now three purpose-built pages** (operator-requested split):
  1. **`/watch.html` (NEW — CORE "Observe")**: the tracking page — your personal
     watchlist, live charts, fullscreen chart, symbol search, Σ₀ signals/council. No
     trading anywhere on it (every BUY/SELL affordance hidden; account/positions/order
     UI removed; an inert `#otBg` stub keeps legacy handlers null-safe). Guest-friendly.
  2. **`/stock-trader.html` (repurposed — the TRADING terminal)**: account bar,
     positions/orders/history/advisor, the order ticket, broker/trader pill — and its
     sidebar is now the **🤖 AI tradelist**: the autopilot enters ONLY symbols on this
     user-editable list (contest-ready). Manual buy/sell still works on ANY symbol via
     the ticket's search. Cross-links to Watch.
  3. **`/options.html` (NEW — EXTENSION trading/TRADING_ENABLED)**: the options trader
     (shadow) with per-depth/per-rule expectancy verdicts + "what would it trade right
     now" probe, a live options-chain viewer, and advisory covered-call/CSP/collar
     proposals — all on existing endpoints; nothing places orders.

- trading/tradelist: **watchlist ≠ tradelist.** New `lib/tradelist-store.js` +
  `GET/POST/DELETE /api/trading/tradelist` (mirrors the watchlist store/routes; seeds
  from `tradelist.seed.json` = the measured ETF basket, never from the watchlist). The
  scanner now covers the **union** of watchlists + tradelists (`trader-agent`), and the
  autoscan **autopilot filter switched from watchlist → tradelist** — the AI trades its
  own list; the watchlist is tracking-only. Covered by `test/tradelist-store.test.js`.

  Surface governance: watch=CORE Observe (loop-stage meta), options=EXTENSION → 21
  core / 22 ext = ratio 1.048 ≤ 1.05 cap; surface-boundary suite green. Pages
  registered in pages.js PUBLIC_PAGES, auth-gate PUBLIC, and site-chrome nav
  (Watch · Trader · Options).
