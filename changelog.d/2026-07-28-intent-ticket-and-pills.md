### Changed
- **The order ticket opens only when you reach for a trade.** It previously
  auto-opened on page load, on every symbol click, and on chart taps — consuming
  ~30% of the viewport (and burying the ☰ menu) before any trading intent. Now
  only the explicit affordances open it (BUY/SELL buttons, B/S keys); selecting
  symbols retargets an already-open ticket without forcing it open. The deck
  gets the full width on load.
- **Options page joins the terminal header family**: the same VIX-regime and
  session (OPEN/CLOSED) pills the trader header shows, fed by the same
  market-status endpoint, refreshed every 60s.
